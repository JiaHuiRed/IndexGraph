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
