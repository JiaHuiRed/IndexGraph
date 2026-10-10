'use strict';
// T04 — explore ranking: CJK bigrams, English natural language, the relevance
// floor, and IG-04's call-graph rescue of filtered wrappers (matchReason).
const { test } = require('node:test');
const assert = require('node:assert');
const { buildIndex } = require('../lib/index-store');
const { explore, nodeInfo } = require('../lib/query');
const { makeProject } = require('./helpers');

function projectWith(t, html) {
  return buildIndex(makeProject(t, { 'index.html': html }));
}

test('T04a: name hits rank above body-only mentions', (t) => {
  const index = projectWith(t, `<script>
function renderModal() { /* modal modal logic */ return 'modal'; }
function openPanel() { renderModal(); }
function unrelated() { return 42; }
</script>`);
  const results = explore(index, 'modal', 5);
  assert.ok(results.length >= 1);
  assert.equal(results[0].name, 'renderModal', 'name hit is top-1');
});

test('T04b: CJK bigram query finds the matching function', (t) => {
  const index = projectWith(t, `<script>
function vIncomeLedger() {
  // 高新收入辅助账 汇总逻辑
  return 'il summary';
}
function vOther() { return 'x'; }
</script>`);
  const results = explore(index, '高新收入辅助账', 5);
  assert.ok(results.some(r => r.name === 'vIncomeLedger'), 'CJK query reaches the symbol');
});

test('T04c: relevance floor still rejects lone one-off mentions', (t) => {
  const index = projectWith(t, `<script>
function noiseFn() { const filterWrap = 1; return 0; }
function totallyUnrelated() { return 7; }
</script>`);
  const results = explore(index, 'backdrop-filter', 5);
  assert.deepEqual(results.map(r => r.name), [], 'single stray mention must not masquerade as a match');
});

test('T04d: caller of a strong direct hit is rescued with matchReason graph', (t) => {
  // IG-04: openPanel has ZERO text relevance but calls renderModal — the
  // v0.0.7 floor dropped it before CALL_PROPAGATION could apply.
  const index = projectWith(t, `<script>
function openPanel() { renderModal(); }
function renderModal() { /* modal modal logic */ return 'modal'; }
function bystander() { return 1; }
</script>`);
  const results = explore(index, 'modal', 10);
  const openPanel = results.find(r => r.name === 'openPanel');
  assert.ok(openPanel, 'wrapper must survive via the call graph');
  assert.equal(openPanel.matchReason, 'graph');
  const direct = results.find(r => r.name === 'renderModal');
  assert.equal(direct.matchReason, 'direct');
  assert.ok(direct.score >= openPanel.score, 'graph entry must not outrank the direct hit');
});

test('T04e: call edges are per-symbol — same-name callees do not cross-contaminate', (t) => {
  // submitA calls ITS OWN renderTable; propagation must not credit submitB
  // through b.html's same-name symbol.
  const root = makeProject(t, {
    'a.html': '<script>\nfunction submitA(){ renderTable(); }\nfunction renderTable(){ return 1; }\n</script>',
    'b.html': '<script>\nfunction submitB(){ renderTable(); }\nfunction renderTable(){ return 2; }\n</script>',
  });
  const index = buildIndex(root);
  const results = explore(index, 'renderTable', 10);
  const byFile = name => results.filter(r => r.name === name);
  const aSub = byFile('submitA');
  const bSub = byFile('submitB');
  // Each submitX appears at most once in the ranked list (its own file's copy
  // was boosted; the OTHER file's renderTable is an unresolved candidate for
  // it — unresolved edges carry no score, so no cross boost).
  assert.ok(aSub.length <= 1 && bSub.length <= 1);
  // And the direct hits both surface with matchReason direct.
  assert.deepEqual(results.filter(r => r.name === 'renderTable').map(r => r.matchReason), ['direct', 'direct']);
});

test('T04f: node lookup with file filter disambiguates same-name symbols', (t) => {
  const root = makeProject(t, {
    'a.html': '<script>\nfunction renderTable(){ return 1; }\n</script>',
    'b.html': '<script>\nfunction renderTable(){ return 2; }\n</script>',
  });
  const index = buildIndex(root);
  const all = nodeInfo(index, 'renderTable').matches;
  assert.equal(all.length, 2);
  const onlyB = nodeInfo(index, 'renderTable', 1, { file: 'b.html' }).matches;
  assert.equal(onlyB.length, 1);
  assert.equal(onlyB[0].file, 'b.html');
});
