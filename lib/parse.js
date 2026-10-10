'use strict';
const acorn = require('acorn');
const walk = require('acorn-walk');

// Parse one extracted <script> block into symbols (named functions) and call
// edges between them. Line numbers in the returned symbols are absolute
// (already offset by the block's position in the original HTML file); `col` is
// the 1-based column of the symbol's first line (relative to the block start
// for its first line — exact for every deeper line). Together they let
// index-store assemble a unique symbol id even for same-name symbols in one
// file.
function parseBlock(content, lineOffset) {
  const ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'script', locations: true });

  const symbols = []; // {name, kind, startLine, endLine, col, params}
  const byNode = new Map(); // node -> symbol, so call edges bind to a specific symbol

  function toAbs(line) { return line + lineOffset - 1; }

  function addSymbol(node, name, kind) {
    if (!name) return;
    const sym = {
      name,
      kind,
      startLine: toAbs(node.loc.start.line),
      endLine: toAbs(node.loc.end.line),
      col: node.loc.start.column + 1,
      params: (node.params || []).map(p => (p.name || p.type)),
    };
    symbols.push(sym);
    byNode.set(node, sym);
  }

  walk.simple(ast, {
    FunctionDeclaration(node) { addSymbol(node, node.id && node.id.name, 'function'); },
    VariableDeclarator(node) {
      if (node.init && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression') && node.id.type === 'Identifier') {
        addSymbol(node, node.id.name, node.init.type === 'ArrowFunctionExpression' ? 'arrow' : 'function');
      }
    },
  });

  const edges = []; // {from, to, fromKey, toKey} — keys are in-block "line:col" identity
  const edgeSeen = new Set();
  const isFuncNode = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
  // An unnamed function expression is a call boundary UNLESS it's the init of
  // a collected VariableDeclarator (`var f = function(){}` — the declarator
  // node itself carries the symbol one level up).
  const isDeclaratorInit = (chain, i) =>
    chain[i + 1] && chain[i + 1].type === 'VariableDeclarator' && chain[i + 1].init === chain[i];

  // Scope map: scope node -> the symbols DECLARED directly inside it. Needed
  // because a shadowing declaration is a SIBLING of the call site (a nested
  // `reset` inside wrapper is not on second's ancestor chain), so the
  // lexically-nearest binding must walk the scope chain level by level, not
  // just the ancestor nodes.
  // acorn-walk's exported `base` is a visitor-function table, not a field
  // list, so enumerate children from the node's own properties instead —
  // anything with a `type` is an AST child; loc/range metadata is skipped
  // naturally (no `type`).
  function eachChild(node, cb) {
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') cb(c); }
      else if (v && typeof v.type === 'string') cb(v);
    }
  }
  const scopeDecls = new Map(); // scope node -> Map(name -> symbol)
  (function visit(node) {
    const decls = new Map();
    scopeDecls.set(node, decls);
    eachChild(node, child => {
      const sym = byNode.get(child);
      if (sym && !decls.has(sym.name)) decls.set(sym.name, sym);
      visit(child);
    });
  })(ast);

  // One pass over every CallExpression with its ancestor chain (instead of
  // walking each function's whole body): the call belongs to the nearest
  // NAMED function ancestor — a nested function owns its own calls, the
  // enclosing scope must not claim them (IG-01). Calls inside an unnamed
  // function (IIFE, method assignment) belong to no indexed symbol and are
  // dropped rather than misattributed. The call TARGET is resolved through
  // the scope chain: innermost scope first, inner declarations shadow outer
  // ones; out-of-chain references (hoisting across siblings, block-scoped
  // declarations) fall back to the block's first same-name symbol.
  walk.ancestor(ast, {
    CallExpression(node, _state, chain) {
      const callee = node.callee;
      if (callee.type !== 'Identifier') return;

      let owner = null;
      for (let i = chain.length - 2; i >= 0; i--) {
        const a = chain[i];
        const sym = byNode.get(a);
        if (sym) { owner = sym; break; }
        if (isFuncNode(a) && !isDeclaratorInit(chain, i)) break; // unnamed function boundary
      }
      if (!owner || callee.name === owner.name) return; // no owner, or self-recursion

      let target = null;
      for (let i = chain.length - 2; i >= 0 && !target; i--) {
        const decls = scopeDecls.get(chain[i]);
        if (decls) target = decls.get(callee.name) || null;
      }
      if (!target) target = symbols.find(s => s.name === callee.name);
      if (!target) {
        // Not resolvable inside this block (typically a cross-file call in a
        // multi-HTML project). Recorded as an UNRESOLVED candidate edge —
        // index-store keeps it only when the name is a real project symbol
        // elsewhere, so DOM/console calls don't become graph noise. It is
        // never presented as a certain edge (audit IG-01).
        edges.push({
          from: owner.name,
          to: callee.name,
          fromKey: owner.startLine + ':' + owner.col,
          unresolved: true,
        });
        return;
      }

      const key = owner.name + '#' + owner.startLine + ':' + owner.col + '->' +
                  target.name + '#' + target.startLine + ':' + target.col;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({
          from: owner.name,
          to: target.name,
          fromKey: owner.startLine + ':' + owner.col,
          toKey: target.startLine + ':' + target.col,
        });
      }
    },
  });

  return { symbols, edges };
}

// ── CSS ──────────────────────────────────────────────────────────────────
// Parse one extracted <style> block into rule symbols. No call-edge graph
// here (no analog to a JS call for CSS) — each rule is a standalone symbol,
// same "name + line range" shape as a JS function, so it's found and read
// through the exact same indexgraph_node / indexgraph_explore path.

// @-rules whose body is itself a nested stylesheet (real selectors inside) —
// recursed into so the selectors underneath are indexed individually.
// Anything else starting with '@' (@keyframes, @font-face, @import, ...) is
// indexed as one opaque symbol instead: their "bodies" aren't selector lists
// (keyframe percentages, declarations, a URL) so there's nothing useful to
// split further.
const RECURSIVE_AT_RULES = new Set(['media', 'supports', 'document', 'layer']);

function normalizeSelector(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Bare class/id tokens (with and without the leading . / #) plus top-level
// comma-separated branches of a selector, registered as lookup aliases so
// `indexgraph_node('group-hdr')` finds `table.rec-table th.group-hdr`
// without the caller needing to know/type the exact compound selector.
function selectorAliases(selector) {
  const aliases = new Set();
  const re = /[.#]([-\w]+)/g;
  let m;
  while ((m = re.exec(selector))) { aliases.add(m[1]); aliases.add(m[0]); }
  let depth = 0, start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      const part = normalizeSelector(selector.slice(start, i));
      if (part) aliases.add(part);
      start = i + 1;
    }
  }
  if (start > 0) {
    const part = normalizeSelector(selector.slice(start));
    if (part) aliases.add(part);
  }
  return [...aliases];
}

// Comment bodies replaced with spaces (newlines kept) so brace-matching and
// prelude text never see `/* ... */` contents, without shifting any offsets.
function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

// Split `text` into top-level `{prelude}{body}` blocks (brace-depth aware —
// nested @media/@keyframes bodies don't get split early) or no-body at-rule
// statements ending in `;` (e.g. `@import url(...);`). Positions are offsets
// into `text`; body excludes the outer { }.
function splitTopLevelRules(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const preludeStart = i;
    let depth = 0;
    while (i < n) {
      const c = text[i];
      if (c === '{' || (c === ';' && depth === 0)) break;
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (i >= n) break; // unterminated trailing prelude, nothing to record
    const prelude = text.slice(preludeStart, i);
    if (text[i] === ';') {
      out.push({ prelude, preludeStart, body: '', bodyStart: i, bodyEnd: i + 1 });
      i++;
      continue;
    }
    const bodyStart = i + 1;
    let braceDepth = 1, j = bodyStart;
    while (j < n && braceDepth > 0) {
      if (text[j] === '{') braceDepth++;
      else if (text[j] === '}') braceDepth--;
      j++;
    }
    out.push({ prelude, preludeStart, body: text.slice(bodyStart, j - 1), bodyStart, bodyEnd: j });
    i = j;
  }
  return out;
}

function lineOf(text, pos, lineOffset) {
  return lineOffset + (text.slice(0, pos).match(/\n/g) || []).length;
}

// 1-based column of `pos` in `text` — for symbol ids (uniqueness within a
// line), not user display.
function colOf(text, pos) {
  const nl = text.lastIndexOf('\n', pos - 1);
  return pos - nl;
}

function collectCssSymbols(text, lineOffset, symbols, contextPrefix) {
  contextPrefix = contextPrefix || '';
  for (const r of splitTopLevelRules(text)) {
    const preludeTrim = normalizeSelector(r.prelude);
    if (!preludeTrim) continue; // stray `;` between rules

    const startLine = lineOf(text, r.preludeStart, lineOffset);
    const endLine = lineOf(text, r.bodyEnd - 1, lineOffset);
    const col = colOf(text, r.preludeStart);

    if (preludeTrim[0] === '@') {
      const atMatch = preludeTrim.match(/^@([a-zA-Z-]+)/);
      const atName = atMatch ? atMatch[1].toLowerCase() : '';
      if (RECURSIVE_AT_RULES.has(atName) && r.body.trim()) {
        const before = symbols.length;
        collectCssSymbols(r.body, lineOf(text, r.bodyStart, lineOffset), symbols, contextPrefix + preludeTrim + ' » ');
        if (symbols.length > before) continue; // recursed into real selectors, skip the wrapper itself
      }
      const rest = atMatch ? preludeTrim.slice(atMatch[0].length).trim() : '';
      symbols.push({ name: contextPrefix + preludeTrim, kind: 'css-at-rule', startLine, endLine, col, aliases: rest ? [rest] : [] });
      continue;
    }

    symbols.push({ name: contextPrefix + preludeTrim, kind: 'css-rule', startLine, endLine, col, aliases: selectorAliases(preludeTrim) });
  }
}

function parseCssBlock(content, lineOffset) {
  const symbols = [];
  collectCssSymbols(stripCssComments(content), lineOffset, symbols);
  return { symbols, edges: [] };
}

module.exports = { parseBlock, parseCssBlock };
