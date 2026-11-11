'use strict';
// Vue SFC (0.1.0 batch C): template elements bind to <script setup> symbols
// through @click directives, scoped <style> rules become style candidates,
// dynamic :class stays a candidate, and component tags are recognized by the
// compiler's own tagType — not by name guessing.
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/index-store');
const { trace } = require('../lib/ui-trace');
const { makeProject } = require('./helpers');

const SFC = `<script setup lang="ts">
import { ref } from "vue";
const title = ref("x");
const panelCls = ref("a");
function handleSave() { doSave(title.value); }
function doSave(v: string) { console.log(v); }
</script>

<template>
  <div class="panel">
    <button class="save-btn" id="save" @click="handleSave">保存设置</button>
    <input :class="panelCls" type="text" @input="onInput" />
    <MyWidget :title="title" />
  </div>
</template>

<style scoped>
.panel { padding: 4px; }
.save-btn { color: blue; }
</style>
`;

function vueProject(t, files) {
  return store.ensureFresh(makeProject(t, files));
}

test('Vue: template button traces to script setup handler with direct evidence', (t) => {
  const index = vueProject(t, { 'SettingsPanel.vue': SFC });
  const m = trace(index, { text: '保存设置' }).matches[0];
  assert.equal(m.tag, 'button');
  assert.equal(m.component.name, 'SettingsPanel', 'componentName comes from the SFC file name');
  const ev = m.events[0];
  assert.equal(ev.attr, '@click');
  assert.equal(ev.handler, 'handleSave');
  assert.equal(ev.evidence, 'direct', 'bare identifier directive is a direct binding');
  assert.equal(ev.symbol.startLine, 5, 'script symbols are shifted to absolute file lines');
  assert.ok(ev.calls.some(c => c.name === 'doSave'), 'calls chain works across the setup script');
  assert.ok(m.styleCandidates.some(r => r.name.includes('.save-btn')), 'scoped style rule is a candidate');
});

test('Vue: dynamic :class stays candidate; static attrs indexed; unknown handlers honest', (t) => {
  const index = vueProject(t, { 'SettingsPanel.vue': SFC });
  const input = trace(index, { selector: 'input' }).matches[0];
  assert.equal(input.candidateClass, 'panelCls', ':class expression kept as candidate text');
  assert.equal(input.attrs.type, 'text');
  assert.equal(input.events[0].attr, '@input');
  assert.equal(input.events[0].notIndexed, true, 'onInput is not defined in the SFC — reported, not guessed');
});

test('Vue: component tags use the compiler tagType, not capitalization', (t) => {
  const index = vueProject(t, { 'SettingsPanel.vue': SFC });
  const m = trace(index, { tag: 'MyWidget' }).matches[0];
  assert.equal(m.kind, 'component-use');
  assert.deepEqual(m.componentUses, [], 'unresolved component reference invents no definition');
});

test('Vue: script call edges and CSS rules coexist in one entry', (t) => {
  const index = vueProject(t, { 'SettingsPanel.vue': SFC });
  const entry = index.files['SettingsPanel.vue'];
  assert.ok(entry.symbols.some(s => s.name === 'handleSave' && s.startLine === 5));
  assert.ok(entry.symbols.some(s => s.name === '.panel' && s.kind === 'css-rule' && s.startLine >= 16));
  assert.ok(entry.edges.some(e => e.from === 'handleSave' && e.to === 'doSave'));
  assert.ok(!entry.parseError, 'clean SFC records no parseError');
});

test('Vue: broken template records the error, script symbols still index', (t) => {
  const index = vueProject(t, {
    'Broken.vue': `<script setup>
function stillHere() { return 1; }
</script>
<template>
  <div><button @click="stillHere">GO</button></unclosed-div>
</template>`,
  });
  const entry = index.files['Broken.vue'];
  assert.ok(entry.symbols.some(s => s.name === 'stillHere'), 'script survives a broken template');
  assert.ok(entry.parseError, 'template problem is recorded');
  const m = trace(index, { text: 'GO' }).matches[0];
  assert.equal(m.events[0].handler, 'stillHere', 'parseable part of the template still traces');
});
