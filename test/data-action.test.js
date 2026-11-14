'use strict';
// Static data-action lookup across HTML, JSX/TSX and Vue, with real index
// persistence, incremental updates and CLI coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const store = require('../lib/index-store');
const { trace, formatTrace } = require('../lib/ui-trace');
const { makeProject } = require('./helpers');

const files = {
  'legacy.html': '<button data-action="save" onclick="saveLegacy()">Save</button><script>function saveLegacy() {}</script>',
  'Panel.tsx': `export function Panel() {
  const save = () => {};
  return <section>
    <button data-action="save" onClick={save}>Save</button>
    <button data-action={"open-settings"}>Settings</button>
    <button data-action={runtimeAction}>Dynamic</button>
    <button data-action="save-other">Other</button>
  </section>;
}`,
  'Panel.vue': `<script setup>
function saveVue() {}
</script>
<template><button data-action="save" @click="saveVue">Save</button>
<button :data-action="runtimeAction">Dynamic</button></template>`,
};

test('data-action: exact static match across HTML, TSX and Vue, with event evidence', (t) => {
  const root = makeProject(t, files);
  const index = store.ensureFresh(root);
  assert.equal(index.schemaVersion, 4);
  const result = trace(index, { dataAction: 'save' }, { limit: 10 });
  assert.equal(result.matches.length, 3);
  assert.deepEqual(new Set(result.matches.map(m => m.file)), new Set(['legacy.html', 'Panel.tsx', 'Panel.vue']));
  for (const m of result.matches) {
    assert.equal(m.attrs['data-action'], 'save');
    assert.ok(m.events.length, 'the selected element retains its event handler');
  }
  assert.equal(trace(index, { dataAction: 'sav' }).matches.length, 0, 'no substring match');
  assert.equal(trace(index, { dataAction: 'save-other' }).matches.length, 1);
  assert.equal(trace(index, { dataAction: 'open-settings' }).matches.length, 1, 'JSX literal expression is static');
  assert.equal(trace(index, { dataAction: 'runtimeAction' }).matches.length, 0, 'dynamic attributes are not indexed as literal values');
  const rendered = formatTrace(result);
  assert.match(rendered, /data-action="save"/);
  assert.match(rendered, /direct binding/);
});

test('data-action: file and selector narrow the lookup; other clues still work', (t) => {
  const index = store.ensureFresh(makeProject(t, files));
  assert.equal(trace(index, { dataAction: 'save' }, { file: 'Panel.tsx' }).matches.length, 1);
  assert.equal(trace(index, { dataAction: 'save', selector: 'input' }).matches.length, 0);
  assert.equal(trace(index, { dataAction: 'save', selector: 'button' }).matches.length, 3);
  assert.equal(trace(index, { text: 'Settings' }).matches.length, 1);
  assert.equal(trace(index, { dataAction: 'absent' }).matches.length, 0);
});

test('data-action: v3 index rebuilds to v4 even when source did not change', (t) => {
  const root = makeProject(t, { 'app.html': '<button data-action="persist">Save</button>' });
  const old = store.buildIndex(root);
  old.schemaVersion = 3;
  delete old.files['app.html'].uiElements[0].attrs;
  store.saveIndex(root, old);
  const index = store.ensureFresh(root);
  assert.equal(index.schemaVersion, 4);
  assert.equal(trace(index, { dataAction: 'persist' }).matches.length, 1);
});

test('data-action: incremental edit replaces old action without a stale lookup', (t) => {
  const root = makeProject(t, { 'page.html': '<button data-action="before">Go</button>' });
  assert.equal(trace(store.ensureFresh(root), { dataAction: 'before' }).matches.length, 1);
  const file = path.join(root, 'page.html');
  const before = fs.statSync(file);
  fs.writeFileSync(file, '<button data-action="after">Go</button>');
  fs.utimesSync(file, new Date(before.atimeMs + 100), new Date(before.mtimeMs + 100));
  const index = store.ensureFresh(root);
  assert.equal(trace(index, { dataAction: 'before' }).matches.length, 0);
  assert.equal(trace(index, { dataAction: 'after' }).matches.length, 1);
});

test('data-action: CLI trace --data-action reaches indexed UI element', (t) => {
  const root = makeProject(t, { 'index.html': '<button data-action="navigate">Go</button>' });
  store.ensureFresh(root);
  const cli = path.join(__dirname, '..', 'bin', 'indexgraph.js');
  const stdout = execFileSync(process.execPath, [cli, 'trace', '--data-action', 'navigate'], {
    cwd: root, encoding: 'utf8',
  });
  assert.match(stdout, /data-action="navigate"/);
});
