'use strict';
// T05/T06/T07 — index freshness and durability: root relocation must not read
// the old project (IG-02), zero-symbol files are recorded so hot queries don't
// reparse (IG-03), atomic writes and corrupt-JSON recovery (IG-07).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../lib/index-store');
const { nodeInfo } = require('../lib/query');
const { makeProject } = require('./helpers');

const INDEX_JSON = p => path.join(p, '.indexgraph', 'index.json');

test('T06: index whose saved root points elsewhere is rebuilt, reads current project', (t) => {
  // Simulates "project copied from A to B": the copied index.json still names
  // A as its root. isStale must treat it as stale even with identical mtimes,
  // and ensureFresh must end up reading B's own source.
  const root = makeProject(t, {
    'index.html': '<script>\nfunction probe(){ return "FROM-B"; }\n</script>',
  });
  const foreignRoot = path.join(path.dirname(root), 'not-this-project');
  const index = store.buildIndex(root);
  index.root = foreignRoot; // forge the relocated-index state
  fs.mkdirSync(path.join(root, '.indexgraph'), { recursive: true });
  fs.writeFileSync(INDEX_JSON(root), JSON.stringify(index));

  const fresh = store.ensureFresh(root);
  assert.equal(path.resolve(fresh.root), path.resolve(root), 'rebuilt index must carry the current root');

  const matches = nodeInfo(fresh, 'probe').matches;
  assert.equal(matches.length, 1);
  assert.ok(matches[0].source.includes('FROM-B'));
  assert.ok(matches[0].absFile.startsWith(root), 'absFile must resolve under the current root');
});

test('T06b: isStale flags a root mismatch explicitly', (t) => {
  const root = makeProject(t, { 'a.html': '<script>function f(){}</script>' });
  const index = store.buildIndex(root);
  assert.equal(store.isStale(root, index), false);
  assert.equal(store.isStale(path.join(root, 'elsewhere'), index), true, 'different root must be stale');
});

test('T05: index records zero-symbol files and hot queries skip reparsing', (t) => {
  const root = makeProject(t, {
    'empty.html': '<p>no scripts here</p>',
    'real.html': '<script>function visible(){}</script>',
  });

  // Spy on parseBlock via the require cache (index-store and the spy share
  // the same module instance) to count actual parse calls.
  const parseMod = require('../lib/parse');
  const orig = parseMod.parseBlock;
  let parseCalls = 0;
  parseMod.parseBlock = (...args) => { parseCalls++; return orig(...args); };
  t.after(() => { parseMod.parseBlock = orig; });

  const index = store.buildIndex(root);
  assert.ok('empty.html' in index.files, 'zero-symbol files must be recorded');
  assert.deepEqual(index.files['empty.html'].symbols, []);
  assert.equal(index.files['real.html'].symbols[0].name, 'visible');
  assert.ok(parseCalls > 0, 'spy sanity: buildIndex really does parse file bodies');

  // Fresh index → isStale must be false WITHOUT parsing anything (stat only).
  const callsAfterBuild = parseCalls;
  assert.equal(store.isStale(root, index), false);
  assert.equal(parseCalls, callsAfterBuild, 'staleness check must not parse file bodies');

  // Modifying the empty file changes only its own entry — no reparse of real.html.
  const st = fs.statSync(path.join(root, 'real.html'));
  fs.writeFileSync(path.join(root, 'empty.html'), '<p>still no scripts</p>');
  fs.utimesSync(path.join(root, 'real.html'), st.atime, st.mtime); // keep real.html's stamp stable
  const diff = store.scanDiff(root, index);
  assert.deepEqual(diff, { added: [], changed: ['empty.html'], deleted: [] });
});

test('T05b: ensureFresh applies changes incrementally and stays correct', (t) => {
  const root = makeProject(t, {
    'a.html': '<script>function fa(){}</script>',
    'b.html': '<script>function fb(){}</script>',
  });
  const index = store.ensureFresh(root);
  assert.ok(index.files['a.html'] && index.files['b.html']);

  // Change one, add one, delete one — all three diff paths at once.
  const st = fs.statSync(path.join(root, 'a.html'));
  fs.writeFileSync(path.join(root, 'a.html'), '<script>function fa(){ /* v2 */ }\nfunction fa2(){ fa(); }</script>');
  fs.utimesSync(path.join(root, 'a.html'), new Date(st.atimeMs + 100), new Date(st.mtimeMs + 100));
  fs.writeFileSync(path.join(root, 'c.html'), '<script>function fc(){ fa2(); }</script>');
  fs.unlinkSync(path.join(root, 'b.html'));

  const fresh = store.ensureFresh(root);
  assert.ok(!('b.html' in fresh.files), 'deleted file must leave the index');
  assert.ok('c.html' in fresh.files, 'added file must enter the index');
  const fa2 = fresh.files['a.html'].symbols.find(s => s.name === 'fa2');
  assert.ok(fa2, 'changed file must expose its new symbol');
  assert.deepEqual(nodeInfo(fresh, 'fa').matches.map(m => m.name), ['fa']);
  assert.deepEqual(nodeInfo(fresh, 'fa2').matches[0].callers, [], 'fa2 has no callers');
  assert.deepEqual(nodeInfo(fresh, 'fa2').matches[0].callees.map(c => c.to), ['fa']);
  assert.deepEqual(nodeInfo(fresh, 'fc').matches[0].callees.map(c => c.to), ['fa2']);
});

test('T07: corrupt index.json is reported and transparently rebuilt', (t) => {
  const root = makeProject(t, { 'a.html': '<script>function probe(){}</script>' });
  const index = store.buildIndex(root);
  store.saveIndex(root, index);

  fs.writeFileSync(INDEX_JSON(root), '{"schemaVersion": 2, "files": { TRUNCATED');
  assert.equal(store.loadIndex(root), null, 'corrupt JSON must load as null');

  const fresh = store.ensureFresh(root);
  assert.ok(fresh.files['a.html'], 'ensureFresh must rebuild instead of failing');
  assert.ok(fs.existsSync(INDEX_JSON(root)), 'rebuilt index must be saved');
  assert.match(fs.readFileSync(INDEX_JSON(root), 'utf-8'), /"schemaVersion"/);
});

test('T07b: saveIndex leaves no temp files behind', (t) => {
  const root = makeProject(t, { 'a.html': '<script>function f(){}</script>' });
  const index = store.buildIndex(root);
  store.saveIndex(root, index);
  store.saveIndex(root, index);
  const leftovers = fs.readdirSync(path.join(root, '.indexgraph')).filter(f => f.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'atomic write must clean up its temp file');
});

test('T07c: missing index loads as null', (t) => {
  const root = makeProject(t, {});
  assert.equal(store.loadIndex(root), null, 'no index file → null');
});

// ── IG08-F02：坏块不能带走后续好块 ────────────────────────────────────────
test('F02: broken script block does not take later script/style blocks down', (t) => {
  const root = makeProject(t, {
    'page.html': `<script>
  const broken = ; // 故意非法的 JS 语法
</script>
<script>
  function healthyAfterError() { return 42; }
</script>
<style>
  .healthy-style { color: red; }
</style>`,
  });
  const index = store.buildIndex(root);
  const entry = index.files['page.html'];
  assert.ok(entry.symbols.some(s => s.name === 'healthyAfterError'),
    'good script after a broken one must still be indexed');
  assert.ok(entry.symbols.some(s => (s.aliases || []).includes('healthy-style')),
    'good style after a broken script must still be indexed');
  assert.ok(entry.parseError, 'the broken block must still be reported');
  assert.match(entry.parseError, /script@/, 'parseError must name the failing block');
});

test('F02: symbols before AND after a broken block both survive', (t) => {
  const root = makeProject(t, {
    'page.html': `<script>
  function beforeBad() { return 1; }
</script>
<script>
  const broken = ;
</script>
<script>
  function afterBad() { return 2; }
</script>`,
  });
  const index = store.buildIndex(root);
  const names = index.files['page.html'].symbols.map(s => s.name);
  assert.ok(names.includes('beforeBad'), 'symbol before the broken block survives');
  assert.ok(names.includes('afterBad'), 'symbol after the broken block survives');
  assert.ok(index.files['page.html'].parseError);
});

test('F02: fixing the broken block clears the error and indexes new symbols', (t) => {
  const root = makeProject(t, {
    'page.html': '<script>\n  const broken = ;\n</script>\n<script>\n  function healthyAfterError() { return 42; }\n</script>',
  });
  const first = store.ensureFresh(root);
  assert.ok(first.files['page.html'].parseError, 'broken state recorded');

  fs.writeFileSync(path.join(root, 'page.html'),
    '<script>\n  const fixed = 1;\n</script>\n<script>\n  function healthyAfterError() { return 42; }\n  function addedLater() { return 3; }\n</script>');
  const fresh = store.ensureFresh(root); // incremental reparse of page.html
  assert.ok(!fresh.files['page.html'].parseError, 'error clears once the file is fixed');
  const names = fresh.files['page.html'].symbols.map(s => s.name);
  assert.ok(names.includes('healthyAfterError') && names.includes('addedLater'),
    'fixed file re-indexes both symbols');
});
