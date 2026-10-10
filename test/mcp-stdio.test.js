'use strict';
// T10 — real MCP stdio round-trip: spawn mcp-server.js as a subprocess and
// call each tool through the actual protocol, not just the internal functions.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const { makeProject } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'mcp-server.js');

function rpc(t, root) {
  const child = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    child.kill();
    // Windows: killed children can leave pipes holding the event loop —
    // destroy them so the test runner actually exits.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf-8');
    for (;;) {
      const sep = buffer.indexOf('\n');
      if (sep === -1) break;
      const line = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (msg.error) console.error('[mcp-test] error response:', JSON.stringify(msg.error));
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.on('data', () => { /* startup logs */ });
  let nextId = 1;
  return (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 20000).unref();
  });
}

// ── IG08-F01：损坏索引必须经真实 stdio 路径自愈 ───────────────────────────
const fs = require('fs');
const INDEX_JSON = p => path.join(p, '.indexgraph', 'index.json');
const HEALTHY = '<script>\nfunction healthy(){ return 1; }\n</script>';

async function initialize(call) {
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ig-test', version: '0.0.0' },
  });
}

test('F01 MCP: corrupt index self-heals through the real stdio path', async (t) => {
  const root = makeProject(t, { 'index.html': HEALTHY });
  require('../lib/index-store').ensureFresh(root); // healthy index first
  fs.writeFileSync(INDEX_JSON(root), '{ "schemaVersion": 2, "files": {'); // then corrupt it
  const call = rpc(t, root);
  await initialize(call);

  const node = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'healthy', projectPath: root },
  });
  const text = node.result.content[0].text;
  assert.match(text, /healthy/, 'corrupt index must self-heal, not report "run init"');
  assert.doesNotMatch(text, /run "indexgraph init"/);
  // index.json repaired to valid current-schema JSON
  const repaired = JSON.parse(fs.readFileSync(INDEX_JSON(root), 'utf-8'));
  assert.equal(repaired.schemaVersion, 2);
});

test('F01 MCP: missing index still asks for init (no silent first-build)', async (t) => {
  const root = makeProject(t, { 'index.html': HEALTHY });
  const call = rpc(t, root);
  await initialize(call);

  const node = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'healthy', projectPath: root },
  });
  assert.match(node.result.content[0].text, /run "indexgraph init"/);
  assert.ok(!fs.existsSync(INDEX_JSON(root)), 'must not silently build an index');
});

test('F02 MCP: symbols from blocks after a broken one still come back over stdio', async (t) => {
  const root = makeProject(t, {
    'page.html': `<script>
  const broken = ;
</script>
<script>
  function healthyAfterError() { return 42; }
</script>
<style>
  .healthy-style { color: red; }
</style>`,
  });
  require('../lib/index-store').ensureFresh(root);
  const call = rpc(t, root);
  await initialize(call);

  const fn = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'healthyAfterError', projectPath: root },
  });
  assert.match(fn.result.content[0].text, /healthyAfterError/);

  const css = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'healthy-style', projectPath: root },
  });
  assert.match(css.result.content[0].text, /healthy-style/);
});

test('T10: initialize + list tools + node/explore/type_info round-trip', async (t) => {
  const root = makeProject(t, {
    'page.html': '<script>\nfunction probeAlpha(){ return 1; }\nfunction probeBeta(){ probeAlpha(); }\n</script>',
    'style.css': '.probe-rule { color: red; }\n',
  });
  // The MCP server requires a pre-built .indexgraph index (query tools tell
  // the agent to run `indexgraph init` otherwise).
  require('../lib/index-store').ensureFresh(root);
  const call = rpc(t, root);

  const init = await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ig-test', version: '0.0.0' },
  });
  assert.equal(init.result.serverInfo.name, 'indexgraph');

  const tools = await call('tools/list', {});
  const names = tools.result.tools.map(x => x.name);
  assert.deepEqual(names, ['indexgraph_node', 'indexgraph_explore', 'indexgraph_type_info']);

  const node = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'probeAlpha', projectPath: root },
  });
  const nodeText = node.result.content[0].text;
  assert.match(nodeText, /probeAlpha/);
  assert.match(nodeText, /probeBeta/, 'caller edge present');

  const explore = await call('tools/call', {
    name: 'indexgraph_explore',
    arguments: { query: 'probeAlpha', projectPath: root, limit: 3 },
  });
  assert.match(explore.result.content[0].text, /probeAlpha/);

  const css = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'probe-rule', projectPath: root },
  });
  assert.match(css.result.content[0].text, /\.probe-rule/);

  const missing = await call('tools/call', {
    name: 'indexgraph_node',
    arguments: { name: 'doesNotExistAnywhere', projectPath: root },
  });
  assert.match(missing.result.content[0].text, /not found/);
});
