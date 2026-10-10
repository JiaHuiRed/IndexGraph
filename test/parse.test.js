'use strict';
// T01/T02 — JS symbol extraction and call edges: exact line ranges, nested
// functions owning their own call edges, same-name symbols across files not
// cross-linking (audit IG-01).
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBlock } = require('../lib/parse');
const { buildIndex } = require('../lib/index-store');
const { nodeInfo } = require('../lib/query');
const { makeProject } = require('./helpers');

test('T01: parseBlock maps absolute line ranges onto the block offset', (t) => {
  // lineOffset 4 = the block's first content line sits at HTML line 4, so the
  // function spans lines 4-6 in the original file.
  const { symbols } = parseBlock('function probe() {\n  return 1;\n}\n', 4);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'probe');
  assert.equal(symbols[0].startLine, 4);
  assert.equal(symbols[0].endLine, 6);
  assert.equal(symbols[0].col, 1, 'col must be present for symbol ids');
});

test('T02a: nested function owns its call edge, the outer scope does not', (t) => {
  // Regression for IG-01 case A: walking outer's whole body used to also
  // record outer->saveData even though inner is the direct caller.
  const { edges } = parseBlock(
    'function outer() {\n  function inner() { saveData(); }\n}\nfunction saveData() {}\n', 1);
  const outerEdges = edges.filter(e => e.from === 'outer');
  assert.deepEqual(outerEdges, [], 'outer must not claim inner\'s call');
  assert.ok(edges.some(e => e.from === 'inner' && e.to === 'saveData'), 'inner->saveData must exist');
});

test('T02b: same-name functions in different files keep callers separated', (t) => {
  // Regression for IG-01 case B: callersOf used to gather edges by bare name
  // across every file, so both renderTable nodes saw both callers.
  const root = makeProject(t, {
    'a.html': '<script>\nfunction submitA(){ renderTable(); }\nfunction renderTable(){ return 1; }\n</script>',
    'b.html': '<script>\nfunction submitB(){ renderTable(); }\nfunction renderTable(){ return 2; }\n</script>',
  });
  const index = buildIndex(root);
  const { matches } = nodeInfo(index, 'renderTable');
  assert.equal(matches.length, 2, 'both files should match by name');

  const a = matches.find(m => m.file === 'a.html');
  const b = matches.find(m => m.file === 'b.html');
  assert.deepEqual(a.callers.map(c => c.from), ['submitA']);
  assert.deepEqual(b.callers.map(c => c.from), ['submitB']);
  // Callers must be pinned to the specific symbol, not just the name.
  assert.notEqual(a.id, b.id, 'same-name symbols must have distinct ids');
  assert.ok(a.callers.every(c => c.fromId !== b.id), 'a.html caller edge must not point into b.html');
});

test('T02c: same-name functions in one file do not cross-wire either', (t) => {
  // Two declarations of `reset` (one shadowing) — each function that calls
  // reset is bound to one specific symbol id.
  const root = makeProject(t, {
    'x.html': `<script>
function first() { reset(); }
function reset() {}
function wrapper() {
  function second() { reset(); }
  function reset() {}
}
</script>`,
  });
  const index = buildIndex(root);
  const resets = nodeInfo(index, 'reset').matches;
  assert.equal(resets.length, 2);
  // first()'s edge points at the top-level reset (line 3), not the nested one.
  const topLevel = resets.find(r => r.startLine === 3);
  const nested = resets.find(r => r.startLine === 6);
  assert.deepEqual(topLevel.callers.map(c => c.from), ['first']);
  assert.deepEqual(nested.callers.map(c => c.from), ['second']);
});
