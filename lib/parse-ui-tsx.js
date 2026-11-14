'use strict';
// TSX/TS module parsing with the TypeScript Compiler API (already a repo
// dependency). One pass produces the same entry shapes the HTML path feeds
// into the index — symbols (named functions/arrows/classes, components flagged
// when a capitalized name contains JSX) and call edges (nearest named-function
// ancestor owns a call, lexical scope chain resolves the target, unresolvable
// ones stay `unresolved` candidates) — plus `uiElements`: JSX tags with their
// static text, class/id/hint attributes and direct event bindings.
//
// Scope/call semantics deliberately mirror lib/parse.js (acorn) so behavior
// stays consistent across HTML inline scripts and component files; the const
// declarator quirk (declaration binds at the declarator node, so sibling-scope
// lexical resolution falls back to the file's first same-name symbol) is
// inherited as-is rather than quietly diverging.
const ts = require('typescript');

const MAX_TEXT_CHARS = 120;
const MAX_EXPR_CHARS = 60;

const FUNC_NODE_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
]);

function isFuncNode(node) { return FUNC_NODE_KINDS.has(node.kind); }

// Subtree contains any JSX element/fragment — the evidence a capitalized
// function is a component.
function containsJsx(node) {
  let found = false;
  (function visit(n) {
    if (found) return;
    if (n.kind === ts.SyntaxKind.JsxElement || n.kind === ts.SyntaxKind.JsxSelfClosingElement || n.kind === ts.SyntaxKind.JsxFragment) { found = true; return; }
    ts.forEachChild(n, visit);
  })(node);
  return found;
}

function classNameOf(sf, node) {
  if (!node.heritageClauses) return null;
  for (const clause of node.heritageClauses) {
    for (const t of clause.types || []) {
      const text = t.expression.getText(sf);
      if (/Component|HTMLElement/.test(text)) return text;
    }
  }
  return null;
}

function paramNames(sf, node) {
  const params = node.parameters || [];
  return params.map(p => (ts.isIdentifier(p.name) ? p.name.text : p.name.getText(sf)));
}

function posToLineCol(sf, pos) {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, col: lc.character + 1 };
}

function truncExpr(sf, node) {
  let text;
  try { text = node.getText(sf); } catch (_) { text = ''; }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_EXPR_CHARS ? text.slice(0, MAX_EXPR_CHARS) + '…' : text;
}

function tagNameText(tag) {
  // TS 5.9+ kinds: a plain tag is a plain Identifier (SyntaxKind.JsxIdentifier
  // no longer exists), a member tag (React.Fragment) is a
  // PropertyAccessExpression, an svg-style tag keeps JsxNamespacedName.
  if (tag.kind === ts.SyntaxKind.Identifier) return tag.text;
  if (tag.kind === ts.SyntaxKind.JsxNamespacedName) return `${tag.namespace.text}:${tag.name.text}`;
  if (tag.kind === ts.SyntaxKind.PropertyAccessExpression) {
    const obj = tagNameText(tag.expression);
    const prop = tag.name && tag.name.text;
    return prop ? (obj ? `${obj}.${prop}` : prop) : '';
  }
  return '';
}

// JSX attribute clues. Mirrors the HTML extractor: static class/id/hint
// attributes are recorded as-is; dynamic ones stay candidates; `on*` names
// carry event bindings — an Identifier initializer is a direct binding, any
// other expression only a candidate (its text is kept as evidence).
const HINT_ATTRS = new Set(['type', 'name', 'href', 'placeholder', 'alt', 'aria-label', 'role', 'data-testid', 'data-action', 'title']);

function handleJsxTag(node, tag, attributes, ownerSym, sf, out) {
  const name = tagNameText(tag);
  if (!name) return null;
  const start = posToLineCol(sf, node.getStart(sf));
  const end = posToLineCol(sf, node.getEnd());
  const el = {
    tag: name,
    kind: /^[A-Z]/.test(name) ? 'component-use' : 'element',
    startLine: start.line,
    endLine: end.line,
    col: start.col,
  };
  if (ownerSym) { el.componentName = ownerSym.name; el.componentKey = `${ownerSym.startLine}:${ownerSym.col}`; }

  const classes = [];
  const attrs = {};
  const events = [];
  let candidateClass = null;
  for (const prop of attributes.properties || []) {
    if (ts.isJsxSpreadAttribute(prop)) continue; // value unknown statically
    if (!ts.isJsxAttribute(prop)) continue;
    const attrName = ts.isIdentifier(prop.name) ? prop.name.text : prop.name.getText(sf);
    const init = prop.initializer;
    if (/^on/.test(attrName)) {
      if (!init) continue;
      if (ts.isStringLiteral(init)) {
        events.push({ attr: attrName, handler: init.text, evidence: 'direct' });
      } else if (ts.isJsxExpression(init) && init.expression) {
        if (ts.isIdentifier(init.expression)) events.push({ attr: attrName, handler: init.expression.text, evidence: 'direct' });
        else events.push({ attr: attrName, handler: truncExpr(sf, init.expression), evidence: 'candidate', dynamic: true });
      }
      continue;
    }
    if (attrName === 'class' || attrName === 'className') {
      if (init && ts.isStringLiteral(init)) classes.push(init.text);
      else if (init && ts.isJsxExpression(init) && init.expression) candidateClass = truncExpr(sf, init.expression);
      continue;
    }
    // A literal wrapped in JSX braces (data-action={"save"}) is also
    // static evidence. Nonliteral expressions remain unknown at index time.
    const staticValue = init && ts.isStringLiteral(init) ? init.text
      : (init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)
        ? init.expression.text : null);
    if (staticValue !== null) {
      if (attrName === 'id') el.idAttr = staticValue;
      else if (HINT_ATTRS.has(attrName)) attrs[attrName] = staticValue;
    }
  }
  if (classes.length) el.classes = classes;
  if (candidateClass) el.candidateClass = candidateClass;
  if (events.length) el.events = events;
  if (Object.keys(attrs).length) el.attrs = attrs;
  out.push(el);
  return el;
}

// Whole-module parse. `scriptKind` is a ts.ScriptKind — TSX for .tsx, TS for
// .vue <script lang="ts">, JS/JSX for plain script content.
function parseTsModule(content, scriptKind) {
  const sf = ts.createSourceFile('module', content, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKind);

  const symbols = [];
  const byNode = new Map(); // declaration node -> symbol

  // 1. Collect named declarations first (nodes only), then build symbols —
  //    component classification needs hasJsx, which is cheap only after the
  //    whole tree is in hand.
  const decls = [];
  (function collect(node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      decls.push({ node, name: node.name.text, kind: 'function' });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      decls.push({ node, name: node.name.text, kind: ts.isArrowFunction(node.initializer) ? 'arrow' : 'function' });
    } else if (ts.isClassDeclaration(node) && node.name) {
      decls.push({ node, name: node.name.text, kind: 'class' });
    }
    ts.forEachChild(node, collect);
  })(sf);

  for (const d of decls) {
    const start = posToLineCol(sf, d.node.getStart(sf));
    const end = posToLineCol(sf, d.node.getEnd());
    let kind = d.kind;
    if (kind === 'class') {
      const base = classNameOf(sf, d.node);
      if (/^[A-Z]/.test(d.name) && (containsJsx(d.node) || base)) kind = 'component';
    } else if (containsJsx(d.node) && /^[A-Z]/.test(d.name)) {
      kind = 'component';
    }
    const sym = { name: d.name, kind, startLine: start.line, endLine: end.line, col: start.col, params: paramNames(sf, d.node) };
    symbols.push(sym);
    byNode.set(d.node, sym);
  }

  const symbolsByName = new Map();
  for (const s of symbols) if (!symbolsByName.has(s.name)) symbolsByName.set(s.name, s);

  // 2. Scope map, same shape as lib/parse.js: every node -> the symbols
  //    DECLARED among its direct children.
  const scopeDecls = new Map();
  (function visit(node) {
    const declsHere = new Map();
    scopeDecls.set(node, declsHere);
    ts.forEachChild(node, child => {
      const sym = byNode.get(child);
      if (sym && !declsHere.has(sym.name)) declsHere.set(sym.name, sym);
      visit(child);
    });
  })(sf);

  const edges = [];
  const edgeSeen = new Set();
  const isDeclaratorInit = n => ts.isVariableDeclaration(n.parent) && n.parent.initializer === n;

  // 3. Call edges: nearest named-function ancestor owns the call; the target
  //    resolves through the scope chain with the same-name fallback.
  (function walkCalls(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const calleeName = node.expression.text;
      let owner = null;
      for (let a = node.parent; a; a = a.parent) {
        const sym = byNode.get(a);
        if (sym) { owner = sym; break; }
        if (isFuncNode(a) && !isDeclaratorInit(a)) break; // unnamed function boundary
      }
      if (!owner || calleeName === owner.name) {
        ts.forEachChild(node, walkCalls);
        return;
      }
      let target = null;
      for (let a = node.parent; a && !target; a = a.parent) {
        const declsHere = scopeDecls.get(a);
        if (declsHere) target = declsHere.get(calleeName) || null;
      }
      if (!target) target = symbolsByName.get(calleeName) || null;
      if (!target) {
        edges.push({ from: owner.name, to: calleeName, fromKey: `${owner.startLine}:${owner.col}`, unresolved: true });
      } else {
        const key = `${owner.name}#${owner.startLine}:${owner.col}->${target.name}#${target.startLine}:${target.col}`;
        if (!edgeSeen.has(key)) {
          edgeSeen.add(key);
          edges.push({ from: owner.name, to: target.name, fromKey: `${owner.startLine}:${owner.col}`, toKey: `${target.startLine}:${target.col}` });
        }
      }
    }
    ts.forEachChild(node, walkCalls);
  })(sf);

  // 4. UI elements: every JSX tag with attribution to its nearest named
  //    ancestor (the containing component in the common case).
  const uiElements = [];
  (function walkUi(node, ownerSym) {
    let owner = ownerSym;
    const sym = byNode.get(node);
    if (sym) owner = sym;
    if (ts.isJsxElement(node)) {
      const el = handleJsxTag(node, node.openingElement.tagName, node.openingElement.attributes, owner, sf, uiElements);
      const textParts = [];
      for (const child of node.children) {
        if (child.kind === ts.SyntaxKind.JsxText && child.text.trim()) textParts.push(child.text.trim());
      }
      if (textParts.length && el) {
        const joined = textParts.join(' ').replace(/\s+/g, ' ').trim();
        el.text = joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) + '…' : joined;
      }
    } else if (ts.isJsxSelfClosingElement(node)) {
      handleJsxTag(node, node.tagName, node.attributes, owner, sf, uiElements);
    }
    ts.forEachChild(node, child => walkUi(child, owner));
  })(sf, null);

  return { symbols, edges, uiElements };
}

module.exports = { parseTsModule };
