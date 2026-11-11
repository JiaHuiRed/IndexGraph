'use strict';
// UI trace (0.1.0 batch B): from visible clues — button text, class, id,
// component, selector — to component, event bindings, handler call chains and
// CSS style candidates, with honest evidence labels. Fixtures are throwaway
// projects (test/helpers), never real ones.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../lib/index-store');
const { trace, formatTrace, parseSelector } = require('../lib/ui-trace');
const { makeProject } = require('./helpers');

const REACT_PANEL = `function updateSettings(v) { persist(v); }

function SaveIcon() {
  return <svg className="icon" aria-label="icon" />;
}

export function SettingsPanel() {
  const handleSave = () => { updateSettings("x"); };
  return (
    <div className="settings-panel">
      <button className="settings-save" id="save-btn" onClick={handleSave}>保存设置</button>
      <button onClick={() => alert("bye")}>取消</button>
      <SaveIcon className={panelCls} aria-label="save icon" />
      <GhostButton />
    </div>
  );
}`;

const CSS = `.settings-panel { padding: 8px; }
@media (max-width: 600px) {
  .settings-save { width: 100%; }
}`;

function freshProject(t, files) {
  const root = makeProject(t, files);
  return store.ensureFresh(root);
}

test('trace by text locates the element, its component, direct binding and calls', (t) => {
  const index = freshProject(t, {
    'src/SettingsPanel.tsx': REACT_PANEL,
    'src/api.tsx': 'export function persist(v) { console.log(v); }\n',
    'styles/settings.css': CSS,
  });
  const result = trace(index, { text: '保存设置' }, { depth: 2 });
  assert.equal(result.matches.length, 1, 'exact text match returns the one button');
  const m = result.matches[0];
  assert.equal(m.tag, 'button');
  assert.equal(m.component.name, 'SettingsPanel');
  assert.equal(m.idAttr, 'save-btn');
  assert.deepEqual(m.classes, ['settings-save']);

  assert.equal(m.events.length, 1);
  const ev = m.events[0];
  assert.equal(ev.attr, 'onClick');
  assert.equal(ev.handler, 'handleSave');
  assert.equal(ev.evidence, 'direct');
  assert.ok(ev.symbol, 'handleSave must bind to its indexed symbol');
  assert.equal(ev.symbol.startLine, 8, 'handleSave is on line 8 of the fixture');
  assert.ok(ev.calls.some(c => c.name === 'updateSettings' && c.level === 1), 'depth 1 has the direct callee');
  assert.ok(ev.calls.some(c => c.name === 'persist' && c.level === 2), 'depth 2 reaches the cross-file call into api.tsx');

  // CSS candidate: the rule inside @media carries its context prefix
  assert.ok(m.styleCandidates.some(r => r.name.includes('.settings-save')), 'style candidate names the rule');
  const mediaRule = m.styleCandidates.find(r => r.name.includes('@media'));
  assert.ok(mediaRule, '@media context is preserved in the candidate');
});

test('trace labels a non-symbol handler honestly and keeps dynamic expressions candidates', (t) => {
  const index = freshProject(t, { 'src/SettingsPanel.tsx': REACT_PANEL });
  const cancel = trace(index, { text: '取消' }).matches[0];
  assert.equal(cancel.events[0].evidence, 'candidate', 'inline arrow is a candidate, never direct');
  assert.equal(cancel.events[0].dynamic, true);

  const icon = trace(index, { tag: 'SaveIcon' }).matches[0];
  assert.equal(icon.kind, 'component-use');
  assert.ok(icon.componentUses.some(d => d.name === 'SaveIcon'), 'component-use resolves to its local definition');
  assert.ok(icon.componentUses.every(d => d.file.endsWith('.tsx')), 'definition carries its file');

  const ghost = trace(index, { tag: 'GhostButton' }).matches[0];
  assert.equal(ghost.kind, 'component-use');
  assert.deepEqual(ghost.componentUses, [], 'an unindexed component reference invents no definition');
});

test('trace class clue finds CSS candidates in standalone stylesheets; dynamic class stays a candidate', (t) => {
  const index = freshProject(t, { 'src/SettingsPanel.tsx': REACT_PANEL, 'styles/settings.css': CSS });
  const m = trace(index, { className: 'settings-save' }).matches[0];
  assert.ok(m.styleCandidates.length >= 1);
  const dynamic = trace(index, { tag: 'SaveIcon' }).matches[0];
  assert.equal(dynamic.candidateClass, 'panelCls', 'the dynamic className expression text is kept');
});

test('legacy HTML: onclick attribute binds to the inline script symbol', (t) => {
  const index = freshProject(t, {
    'legacy.html': '<html><body>\n<button class="legacy-go" onclick="goLegacy()">GO</button>\n<script>function goLegacy(){ boot(); }\nfunction boot(){}</script>\n</body></html>',
  });
  const m = trace(index, { className: 'legacy-go' }).matches[0];
  assert.equal(m.events[0].attr, 'onclick');
  assert.equal(m.events[0].evidence, 'direct');
  assert.ok(m.events[0].symbol, 'onclick target is the inline-script symbol');
});

test('selector clue is a hard CSS-semantics filter', (t) => {
  const index = freshProject(t, { 'src/SettingsPanel.tsx': REACT_PANEL });
  const hit = trace(index, { text: '取消', selector: 'button' });
  assert.equal(hit.matches.length, 1);
  const miss = trace(index, { text: '取消', selector: 'input' });
  assert.equal(miss.matches.length, 0, 'wrong tag filters the element out');
  const clsMiss = trace(index, { selector: '.no-such-class' });
  assert.equal(clsMiss.matches.length, 0);
});

test('file clue disambiguates repeated labels; limit overflows into omitted', (t) => {
  const index = freshProject(t, {
    'a.tsx': 'export function A() {\n  return <button className="go">开始</button>;\n}\n',
    'b.tsx': 'export function B() {\n  return <button className="go">开始</button>;\n}\n',
  });
  const both = trace(index, { text: '开始' });
  assert.equal(both.matches.length, 2, 'repeated labels: every source comes back, none picked at random');
  const only = trace(index, { text: '开始' }, { file: 'b.tsx' });
  assert.equal(only.matches.length, 1);
  assert.ok(only.matches[0].file.endsWith('b.tsx'));

  const limited = trace(index, { className: 'go' }, { limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.omitted.length, 1);
  assert.match(formatTrace(limited), /omitted/);
});

test('incremental update: renaming the class moves the style candidate, no stale edges', (t) => {
  const root = makeProject(t, {
    'p.tsx': 'export function P() {\n  return <button className="old-cls" onClick={go}>GO</button>;\n}\nfunction go(){}\n',
    's.css': '.old-cls { color: red; }\n',
  });
  const before = trace(store.ensureFresh(root), { className: 'old-cls' });
  assert.equal(before.matches.length, 1);
  assert.ok(before.matches[0].styleCandidates.some(r => r.name.includes('.old-cls')));

  fs.writeFileSync(path.join(root, 'p.tsx'),
    'export function P() {\n  return <button className="new-cls" onClick={go}>GO</button>;\n}\nfunction go(){}\n');
  fs.writeFileSync(path.join(root, 's.css'), '.new-cls { color: blue; }\n');
  // The rename keeps p.tsx's byte size identical, so without bumping mtime the
  // MTIME_TOLERANCE_MS window can classify it as unchanged — push the stamps
  // like T05b does instead of racing the tolerance.
  const st0 = fs.statSync(path.join(root, 'p.tsx'));
  fs.utimesSync(path.join(root, 'p.tsx'), new Date(st0.mtimeMs + 100), new Date(st0.mtimeMs + 100));
  fs.utimesSync(path.join(root, 's.css'), new Date(st0.mtimeMs + 100), new Date(st0.mtimeMs + 100));
  const fresh = store.ensureFresh(root);
  const after = trace(fresh, { className: 'old-cls' });
  assert.equal(after.matches.length, 0, 'renamed class no longer matches');
  const moved = trace(fresh, { className: 'new-cls' }).matches[0];
  assert.ok(moved.styleCandidates.some(r => r.name.includes('.new-cls')), 'candidate follows the rename');
  assert.ok(!moved.styleCandidates.some(r => r.name.includes('.old-cls')), 'stale rule never surfaces');
});

test('parseSelector handles tag/class/id mixes and rejects garbage', (t) => {
  assert.deepEqual(parseSelector('div.save#main.item'), { tag: 'div', classes: ['save', 'item'], id: 'main' });
  assert.deepEqual(parseSelector('.save'), { tag: null, classes: ['save'], id: null });
  assert.equal(parseSelector('>>>'), null);
  assert.equal(parseSelector('  '), null);
});

test('formatTrace carries the caveat and evidence labels', (t) => {
  const index = freshProject(t, {
    'src/SettingsPanel.tsx': REACT_PANEL,
    'styles/settings.css': CSS,
  });
  const text = formatTrace(trace(index, { text: '保存设置' }));
  assert.match(text, /direct binding/);
  assert.match(text, /selector match/);
  assert.match(text, /Caveat:.*NOT verified/);
  const empty = formatTrace(trace(index, { text: 'does-not-exist' }));
  assert.match(empty, /No UI elements match/);
});

test('trace requires at least one clue', (t) => {
  const index = freshProject(t, { 'a.tsx': 'export function A() {\n  return <button>x</button>;\n}\n' });
  const result = trace(index, {});
  assert.match(result.error, /at least one clue/);
});
