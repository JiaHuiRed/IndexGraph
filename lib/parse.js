'use strict';
const acorn = require('acorn');
const walk = require('acorn-walk');

// Parse one extracted <script> block into symbols (named functions) and call
// edges between them. Line numbers in the returned symbols are absolute
// (already offset by the block's position in the original HTML file).
function parseBlock(content, lineOffset) {
  const ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'script', locations: true });

  const symbols = []; // {name, kind, startLine, endLine, params}
  const byNode = new Map(); // node -> symbol, so we can attribute call edges to the enclosing function

  function toAbs(line) { return line + lineOffset - 1; }

  function addSymbol(node, name, kind) {
    if (!name) return;
    const sym = {
      name,
      kind,
      startLine: toAbs(node.loc.start.line),
      endLine: toAbs(node.loc.end.line),
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

  const nameSet = new Set(symbols.map(s => s.name));
  const edges = []; // {from, to}
  const edgeSeen = new Set();

  // Second pass: for each collected function-like node, walk its own body for
  // calls to other known symbols (flat/lexical match, not full scope resolution).
  for (const [node, sym] of byNode.entries()) {
    const bodyNode = node.type === 'VariableDeclarator' ? node.init : node;
    walk.simple(bodyNode, {
      CallExpression(callNode) {
        const callee = callNode.callee;
        if (callee.type === 'Identifier' && nameSet.has(callee.name) && callee.name !== sym.name) {
          const key = sym.name + '->' + callee.name;
          if (!edgeSeen.has(key)) { edgeSeen.add(key); edges.push({ from: sym.name, to: callee.name }); }
        }
      },
    });
  }

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

function collectCssSymbols(text, lineOffset, symbols, contextPrefix) {
  contextPrefix = contextPrefix || '';
  for (const r of splitTopLevelRules(text)) {
    const preludeTrim = normalizeSelector(r.prelude);
    if (!preludeTrim) continue; // stray `;` between rules

    const startLine = lineOf(text, r.preludeStart, lineOffset);
    const endLine = lineOf(text, r.bodyEnd - 1, lineOffset);

    if (preludeTrim[0] === '@') {
      const atMatch = preludeTrim.match(/^@([a-zA-Z-]+)/);
      const atName = atMatch ? atMatch[1].toLowerCase() : '';
      if (RECURSIVE_AT_RULES.has(atName) && r.body.trim()) {
        const before = symbols.length;
        collectCssSymbols(r.body, lineOf(text, r.bodyStart, lineOffset), symbols, contextPrefix + preludeTrim + ' » ');
        if (symbols.length > before) continue; // recursed into real selectors, skip the wrapper itself
      }
      const rest = atMatch ? preludeTrim.slice(atMatch[0].length).trim() : '';
      symbols.push({ name: contextPrefix + preludeTrim, kind: 'css-at-rule', startLine, endLine, aliases: rest ? [rest] : [] });
      continue;
    }

    symbols.push({ name: contextPrefix + preludeTrim, kind: 'css-rule', startLine, endLine, aliases: selectorAliases(preludeTrim) });
  }
}

function parseCssBlock(content, lineOffset) {
  const symbols = [];
  collectCssSymbols(stripCssComments(content), lineOffset, symbols);
  return { symbols, edges: [] };
}

module.exports = { parseBlock, parseCssBlock };
