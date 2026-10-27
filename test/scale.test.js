'use strict';
// T10 — query hot path at scale + cache correctness (0.0.10 perf batch):
// the derived adjacency tables and the parsed-index cache must stay CORRECT
// (and the per-candidate edge scans must not come back). Fixtures are
// synthetic — no dependency on any real project, same rule as the rest of
// the suite.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../lib/index-store');
const { nodeInfo, explore } = require('../lib/query');
const { parseCssBlock } = require('../lib/parse');
const { makeProject } = require('./helpers');

// 400 HTML files x 30 functions (36k call edges) + an 8000-rule stylesheet.
// Sized so the OLD explore (one full edge scan per scored candidate) needed
// seconds here while the derived-table path finishes in tens of ms.
function scaleProject(t, htmlFiles = 400, cssRules = 8000) {
  const files = {};
  for (let f = 0; f < htmlFiles; f++) {
    let js = '';
    for (let i = 0; i < 30; i++) {
      js += `function mod${f}_fn${i}(a, b) {\n  let t = a + b;\n`;
      for (let j = 0; j < 3; j++) js += `  t += mod${f}_fn${(i + j + 1) % 30}(t, j);\n`;
      js += `  return t;\n}\n`;
    }
    files[`page${f}.html`] = `<html><body><script>\n${js}\n</script></body></html>`;
  }
  let css = '';
  for (let r = 0; r < cssRules; r++) {
    css += `.rule-${r} .cell-${r % 50} { color: #${r % 10}${r % 10}${r % 10}; padding: ${r % 20}px; }\n`;
  }
  files['big.css'] = css;
  return makeProject(t, files);
}

test('T10a: explore on an edge/CSS-heavy project stays correct and fast', (t) => {
  const index = store.buildIndex(scaleProject(t));
  const edgeCount = Object.values(index.files).reduce((n, f) => n + f.edges.length, 0);
  assert.ok(edgeCount > 30000, `fixture must be edge-heavy (got ${edgeCount} edges)`);

  const t0 = Date.now();
  const cssHits = explore(index, 'rule-5000 cell padding color', 5);
  const dt = Date.now() - t0;
  assert.ok(cssHits.length > 0, 'the exact CSS rule must be found');
  assert.equal(cssHits[0].name, '.rule-5000 .cell-0', 'exact-name rule ranks first');
  // Regression guard, not a perf claim: the derived-table path runs in tens
  // of ms here; a return to per-candidate full edge scans needs seconds.
  assert.ok(dt < 2000, `explore took ${dt}ms — per-candidate edge scans are back?`);

  // Graph propagation still works at scale: the direct hit first, its callers
  // rescued behind it with the 'graph' tag.
  const jsHits = explore(index, 'mod100_fn15', 3);
  assert.equal(jsHits[0].name, 'mod100_fn15', 'exact function name ranks first');
  assert.ok(jsHits.some(h => h.matchReason === 'graph'), 'callers of a strong hit still enter via the call graph');

  // depth traversal at scale: edges must be per-symbol, not name-merged.
  const deep = nodeInfo(index, 'mod100_fn15', 3);
  assert.equal(deep.matches.length, 1);
  assert.ok(deep.matches[0].callees.length >= 3, 'direct callees present');
  assert.ok(deep.matches[0].callees.every(c => c.file === 'page100.html'), 'callees bind to this file only');
});

test('T10b: parsed-index cache re-reads an index rewritten by another process', (t) => {
  const root = makeProject(t, { 'a.html': '<script>\nfunction fa(){}\n</script>' });
  const first = store.ensureFresh(root);
  assert.ok(first.files['a.html']);
  assert.equal(store.loadIndex(root), store.loadIndex(root),
    'untouched index.json must be parsed once and served from the parsed cache');

  // Another process (e.g. a concurrent CLI `indexgraph init`) lands a rebuild
  // that includes a file this process has never seen.
  fs.writeFileSync(path.join(root, 'b.html'), '<script>\nfunction fb(){}\n</script>');
  store.saveIndex(root, store.buildIndex(root));

  const reloaded = store.loadIndex(root);
  assert.ok(reloaded.files['b.html'], 'rewritten index.json must be re-read, not served from cache');
  const fresh = store.ensureFresh(root);
  assert.ok(fresh.files['b.html'], 'ensureFresh picks up the externally rebuilt index');
  assert.equal(nodeInfo(fresh, 'fb').matches.length, 1, 'query sees the externally indexed symbol');
});

test('T10c: incremental update invalidates derived tables — edges stay current', (t) => {
  const root = makeProject(t, {
    'a.html': '<script>\nfunction fa(){ return 1; }\nfunction wrapper(){ return fa(); }\n</script>',
  });
  const index = store.ensureFresh(root);
  assert.deepEqual(nodeInfo(index, 'fa').matches[0].callers.map(c => c.from), ['wrapper']);

  // Rewire the call graph: wrapper stops calling fa, a new caller appears.
  const st = fs.statSync(path.join(root, 'a.html'));
  fs.writeFileSync(path.join(root, 'a.html'),
    '<script>\nfunction fa(){ return 2; }\nfunction other(){ return fa(); }\n</script>');
  fs.utimesSync(path.join(root, 'a.html'), new Date(st.atimeMs + 100), new Date(st.mtimeMs + 100));

  const fresh = store.ensureFresh(root);
  const callers = nodeInfo(fresh, 'fa').matches[0].callers.map(c => c.from);
  assert.deepEqual(callers, ['other'],
    'derived tables must rebuild for the updated index object, not serve the old edges');
  assert.equal(nodeInfo(fresh, 'wrapper'), null, 'removed function must be gone from the derived name index');
  assert.equal(nodeInfo(fresh, 'fa').matches[0].source.includes('return 2'), true,
    'source is still read fresh from disk');
});

test('T10d: CSS line mapping stays exact on a generated stylesheet', (t) => {
  // Build the sheet while recording the line every rule MUST land on —
  // comments spanning lines, multi-line selectors, nested @media/@supports,
  // opaque @keyframes, and a trailing @import, all mixed.
  let css = '';
  const expected = [];
  let line = 1;
  const push = (name, startLine, endLine) => expected.push({ name, startLine, endLine });
  for (let r = 0; r < 200; r++) {
    css += `/* rule ${r} comment\n   spanning lines */\n`; line += 2;
    css += `.rule-${r} .cell-${r % 7},\n`; line += 1;
    css += `.tag-${r} {\n`; line += 1;
    css += `  color: #abc;\n`; line += 1;
    css += `}\n`; line += 1;
    push(`.rule-${r} .cell-${r % 7}, .tag-${r}`, line - 4, line - 1);
    if (r % 40 === 0) {
      css += `@media (max-width: ${600 + r}px) {\n`; line += 1;
      css += `  .inner-${r} { margin: 0 auto; }\n`; line += 1;
      push(`@media (max-width: ${600 + r}px) » .inner-${r}`, line - 1, line - 1);
      css += `  @supports (display: grid) {\n`; line += 1;
      css += `    .deep-${r} { display: grid; }\n`; line += 1;
      push(`@media (max-width: ${600 + r}px) » @supports (display: grid) » .deep-${r}`, line - 1, line - 1);
      css += `  }\n`; line += 1;
      css += `}\n`; line += 1;
    }
    if (r % 97 === 0) {
      css += `@keyframes spin${r} {\n`; line += 1;
      css += `  from { transform: rotate(0deg); }\n`; line += 1;
      css += `  to { transform: rotate(360deg); }\n`; line += 1;
      css += `}\n`; line += 1;
      push(`@keyframes spin${r}`, line - 4, line - 1);
    }
  }
  css += '@import url("base.css");\n'; line += 1;
  push('@import url("base.css")', line - 1, line - 1);

  const { symbols } = parseCssBlock(css, 1);
  assert.equal(symbols.length, expected.length,
    `every rule indexed (got ${symbols.length}, want ${expected.length})`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(symbols[i].name, expected[i].name, `symbol ${i} name`);
    assert.equal(symbols[i].startLine, expected[i].startLine, `symbol ${i} (${expected[i].name}) startLine`);
    assert.equal(symbols[i].endLine, expected[i].endLine, `symbol ${i} (${expected[i].name}) endLine`);
  }
});
