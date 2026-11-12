'use strict';
// T11 — standalone script files (.js/.mjs/.cjs) are indexed as one script block
// spanning the whole file, the same way a standalone .css is one style block.
// Also covers ESM: an ES module fails acorn's script mode outright, so
// parseBlock retries as `module` rather than dropping the file.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { buildIndex, findIndexableFiles } = require('../lib/index-store');
const { parseBlock } = require('../lib/parse');
const { makeProject } = require('./helpers');

test('T11a: ESM source parses through the module retry (import/export)', () => {
  const src = [
    "import { dep } from './dep.js';",
    'export function greet(name) { return fmt(name); }',
    'export const shout = (s) => fmt(s);',
    'function fmt(v) { return String(v); }',
  ].join('\n');
  const { symbols } = parseBlock(src, 1);
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('greet'), 'export function must be collected');
  assert.ok(names.includes('shout'), 'export const arrow must be collected');
  assert.ok(names.includes('fmt'), 'plain function must be collected');
});

test('T11b: a real syntax error still throws when the caller pins sourceType', () => {
  // No silent retry when sourceType is explicit — a broken file must report.
  assert.throws(() => parseBlock('function broken( {', 1, { sourceType: 'module' }));
});

test('T11c: .js / .mjs / .cjs are discovered, .ts is still out of scope', (t) => {
  const root = makeProject(t, {
    'a.js': 'function a() {}\nmodule.exports = a;\n',
    'b.mjs': 'export function b() {}\n',
    'c.cjs': 'function c() {}\nmodule.exports = c;\n',
    'nested/deep.js': 'function deep() {}\n',
    'skip.ts': 'export function nope() {}\n',
  });
  const found = findIndexableFiles(root)
    .map(f => path.relative(root, f).replace(/\\/g, '/'))
    .sort();
  assert.deepEqual(found, ['a.js', 'b.mjs', 'c.cjs', 'nested/deep.js']);
});

test('T11d: buildIndex pulls symbols and call edges out of a standalone .js', (t) => {
  const root = makeProject(t, {
    'app.js': [
      'function loadUser() { render(); }',
      'function render() { return 1; }',
      'module.exports = { loadUser, render };',
    ].join('\n'),
  });
  const index = buildIndex(root);
  const entry = index.files['app.js'];
  assert.ok(entry, 'app.js must be indexed');
  assert.deepEqual(entry.symbols.map(s => s.name).sort(), ['loadUser', 'render']);
  assert.ok(entry.edges.some(e => e.from === 'loadUser' && e.to === 'render'),
    'in-file call edge loadUser->render must exist');
  assert.equal(entry.parseError, undefined, 'a clean .js must not record a parse error');
});

test('T11e: an ESM .js indexed end-to-end keeps its exported symbols', (t) => {
  const root = makeProject(t, {
    'esm.js': [
      "import { readFileSync } from 'node:fs';",
      'export function loadConfig(p) { return readFileSync(p, "utf-8"); }',
      'export function parseConfig(s) { return JSON.parse(s); }',
    ].join('\n'),
  });
  const index = buildIndex(root);
  const entry = index.files['esm.js'];
  assert.ok(entry, 'ESM .js must be indexed, not dropped');
  assert.deepEqual(entry.symbols.map(s => s.name).sort(), ['loadConfig', 'parseConfig']);
  assert.equal(entry.parseError, undefined, 'module retry must leave no parse error');
});

test('T11f: standalone .js symbols join the same global name space as HTML blocks', (t) => {
  const root = makeProject(t, {
    'page.html': '<html><body><script>function fromHtml() { shared(); }</script></body></html>',
    'lib.js': 'function shared() {}\nfunction fromJs() { shared(); }\n',
  });
  const index = buildIndex(root);
  assert.ok(index.files['page.html'], 'inline html script block indexed');
  assert.ok(index.files['lib.js'], 'standalone js indexed');
  assert.deepEqual(index.files['lib.js'].symbols.map(s => s.name).sort(), ['fromJs', 'shared']);
});

test('T11g: .redcode scratch copies are never indexed', (t) => {
  // A stale snapshot of a function inside agent metadata must not shadow the
  // real source file — the graph has to answer with the live file only.
  const root = makeProject(t, {
    'real.js': 'function loadConfig() {}\n',
    '.redcode/temp/check.js': 'function loadConfig() {}\nfunction staleOnly() {}\n',
    '.redcode/docs/snippet.html': '<html><body><script>function staleHtml() {}</script></body></html>',
  });
  const found = findIndexableFiles(root)
    .map(f => path.relative(root, f).replace(/\\/g, '/'));
  assert.deepEqual(found, ['real.js']);
  const index = buildIndex(root);
  assert.equal(Object.keys(index.files).join(','), 'real.js');
});
