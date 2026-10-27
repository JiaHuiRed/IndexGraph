'use strict';
// T08 — bounded MCP responses (IG-05): total source budget, maxResults, and
// summary mode keep 100 same-name symbols from producing an unbounded answer,
// and the omitted list preserves a way to keep locating the rest.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { buildIndex } = require('../lib/index-store');
const { nodeInfo, NODE_TOTAL_BUDGET_CHARS } = require('../lib/query');
const { makeProject } = require('./helpers');

function hundredSameNameProject(t) {
  const fns = [];
  for (let i = 0; i < 100; i++) {
    fns.push(`function handler_${i}() { return ${i}; }`);
    fns.push(`function handler() { /* variant ${i}: ${'x'.repeat(300)} */ return ${i}; }`);
  }
  // 100 same-name `handler` functions, each padded to a decent size.
  return makeProject(t, { 'big.html': '<script>\n' + fns.join('\n') + '\n</script>' });
}

test('T08a: 100 same-name matches are bounded by the response budget', (t) => {
  const index = buildIndex(hundredSameNameProject(t));
  const { matches, omitted } = nodeInfo(index, 'handler');
  const total = matches.reduce((n, m) => n + (m.source || '').length, 0);
  assert.ok(total <= NODE_TOTAL_BUDGET_CHARS + 4000, `total source ${total} must stay near the budget`);
  assert.ok(matches.length < 100, 'not all matches fit — some must be omitted');
  assert.ok(omitted.length > 0, 'omitted list must be present');
  for (const o of omitted) {
    assert.ok(o.name && o.file && o.startLine, 'each omitted entry keeps a re-query handle');
  }
});

test('T08b: maxResults caps the match list exactly', (t) => {
  const index = buildIndex(hundredSameNameProject(t));
  const { matches, omitted } = nodeInfo(index, 'handler', 1, { maxResults: 3 });
  assert.equal(matches.length, 3);
  assert.equal(omitted.length, 0, 'maxResults users get exactly what they asked for');
});

test('T08c: summary mode returns short source prefixes', (t) => {
  const index = buildIndex(hundredSameNameProject(t));
  const { matches } = nodeInfo(index, 'handler', 1, { mode: 'summary', maxResults: 5 });
  for (const m of matches) {
    assert.ok(m.source.length <= 300 + 80, 'summary source stays small');
    assert.ok(m.startLine > 0 && m.file, 'summary still carries location + edges');
  }
});

test('T08d: tiny budget degrades to omitted entries, never garbage', (t) => {
  const index = buildIndex(hundredSameNameProject(t));
  const { matches, omitted } = nodeInfo(index, 'handler', 1, { maxChars: 100, maxResults: 4 });
  assert.ok(matches.every(m => typeof m.source === 'string'));
  assert.ok(omitted.length + matches.length === 4, 'every match is either returned or accounted for');
});


// T08e — the `file` disambiguation filter must resolve a RELATIVE path against
// the index root, not process.cwd(): an MCP caller passes projectPath pointing
// at the indexed project while its own cwd is elsewhere, and a cwd-resolved
// relative arg silently filters every match away (reported as "not found").
test('T08e: relative file filter resolves against the index root, not cwd', (t) => {
 const root = makeProject(t, {
   'sub/page.html': '<script>\nfunction dup() { return 1; }\n</script>',
   'other.html': '<script>\nfunction dup() { return 2; }\n</script>',
 });
 const index = buildIndex(root);
 const cwd = process.cwd();
 try {
   process.chdir(os.tmpdir()); // simulate projectPath != cwd
   const rel = nodeInfo(index, 'dup', 1, { file: 'sub/page.html' });
   assert.ok(rel, 'relative file arg must still find matches when cwd is elsewhere');
   assert.equal(rel.matches.length, 1);
   assert.equal(rel.matches[0].file, 'sub' + path.sep + 'page.html');
   const abs = nodeInfo(index, 'dup', 1, { file: path.join(root, 'other.html') });
   assert.ok(abs, 'absolute file arg keeps working');
   assert.equal(abs.matches.length, 1);
 } finally {
   process.chdir(cwd);
 }
});