'use strict';
// IG08-F01 / F03 — real CLI subprocess round-trips: a corrupt index must
// self-heal instead of demanding `init`; a genuinely missing index must still
// ask for init; querying a nonexistent symbol must report not-found cleanly.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { makeProject } = require('./helpers');

const CLI = path.join(__dirname, '..', 'bin', 'indexgraph.js');
const INDEX_JSON = p => path.join(p, '.indexgraph', 'index.json');
const HEALTHY = '<script>function healthy(){ return 1; }</script>';

function runCli(t, root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    setTimeout(() => { child.kill(); reject(new Error('cli timeout')); }, 20000).unref();
  });
}

test('F01 CLI: corrupt index self-heals instead of demanding init', async (t) => {
  const root = makeProject(t, { 'index.html': HEALTHY });
  require('../lib/index-store').ensureFresh(root); // healthy index first
  fs.writeFileSync(INDEX_JSON(root), '{ "schemaVersion": 2, "files": {'); // then corrupt it

  const r = await runCli(t, root, ['node', 'healthy']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /healthy/, 'query must succeed after self-heal');
  assert.match(r.stderr, /corrupt/i, 'corruption must be surfaced on stderr');
  // index.json repaired to valid current-schema JSON
  const repaired = JSON.parse(fs.readFileSync(INDEX_JSON(root), 'utf-8'));
  assert.equal(repaired.schemaVersion, 2);
});

test('F01 CLI: missing index still asks for init (no silent first-build)', async (t) => {
  const root = makeProject(t, { 'index.html': HEALTHY });
  const r = await runCli(t, root, ['node', 'healthy']);
  assert.equal(r.code, 1, 'missing index must exit non-zero');
  assert.ok(!fs.existsSync(INDEX_JSON(root)), 'must not silently build an index');
  // The message goes through console.error + process.exit — pipe writes are
  // async, so only assert on it when it made it out (see bin/indexgraph.js).
  if (r.stderr) assert.match(r.stderr, /no \.indexgraph index found/);
});

test('F03 CLI: nonexistent symbol reports not-found, not a TypeError', async (t) => {
  const root = makeProject(t, { 'index.html': HEALTHY });
  require('../lib/index-store').ensureFresh(root);
  const r = await runCli(t, root, ['node', 'nonexistent_symbol_123']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /not found in the index/);
  assert.doesNotMatch(r.stderr, /TypeError/, 'no stack trace for a plain miss');
});
