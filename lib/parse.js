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

module.exports = { parseBlock };
