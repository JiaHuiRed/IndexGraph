'use strict';
// Batch D smoke: (1) a real v2 index upgrades in place via ensureFresh;
// (2) the MCP server answers indexgraph_trace over real stdio JSON-RPC.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('../lib/index-store');
const { makeProject } = require('./helpers');

test('v2 index rebuilds to v4 automatically (copy/move workspace scenario)', (t) => {
  const root = makeProject(t, { 'app.vue': '<template><button class="b" @click="go">GO</button></template>\n<script setup>function go(){}</script>\n' });
  // Forge a v2 index: v3 fields absent, schemaVersion 2.
  fs.mkdirSync(path.join(root, '.indexgraph'), { recursive: true });
  const v2 = { schemaVersion: 2, root: path.resolve(root), builtAt: Date.now() - 5000, files: {} };
  fs.writeFileSync(path.join(root, '.indexgraph', 'index.json'), JSON.stringify(v2));
  const fresh = store.ensureFresh(root);
  assert.equal(fresh.schemaVersion, 4, 'schema bumped to 4');
  const el = fresh.files['app.vue'].uiElements[0];
  assert.equal(el.tag, 'button', 'UI elements rebuilt from source');
  assert.equal(el.events[0].handler, 'go');
});

test('MCP stdio smoke: real server, trace through JSON-RPC on a mixed project', async (t) => {
  const root = makeProject(t, {
    'App.tsx': 'export function App() {\n  const save = () => { persist(); }\n  function persist() {}\n  return <button className="save-btn" onClick={save}>Save</button>;\n}\n',
    'app.css': '.save-btn { color: green; }\n',
  });
  const SERVER = path.join(__dirname, '..', 'mcp-server.js');
  const child = spawn(process.execPath, [SERVER], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    child.kill();
    for (const s of [child.stdin, child.stdout, child.stderr]) s.destroy();
  });
  let buffer = '';
  const pending = new Map();
  let nextId = 1;
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
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 20000).unref();
  });

  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ig-smoke', version: '0.0.0' } });
  // No .indexgraph yet → trace must tell the agent to init, never crash.
  const missing = await call('tools/call', { name: 'indexgraph_trace', arguments: { className: 'save-btn', projectPath: root } });
  assert.match(missing.result.content[0].text, /indexgraph init/);

  store.ensureFresh(root); // now build it
  const traced = await call('tools/call', { name: 'indexgraph_trace', arguments: { text: 'Save', projectPath: root } });
  const text = traced.result.content[0].text;
  assert.match(text, /save-btn/);
  assert.match(text, /App/, 'component surfaced');
  assert.match(text, /direct binding/);
  assert.match(text, /\.save-btn \[selector match\]/);
});
