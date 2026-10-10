'use strict';
// T03 — CSS parsing: selector aliases, @media expansion, line mapping.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCssBlock } = require('../lib/parse');
const { buildIndex } = require('../lib/index-store');
const { nodeInfo } = require('../lib/query');
const { makeProject } = require('./helpers');

test('T03a: bare class/id aliases resolve to the compound rule', (t) => {
  const { symbols } = parseCssBlock(
    'table.rec-table th.group-hdr { color: red; }\n', 1);
  assert.equal(symbols.length, 1);
  assert.ok(symbols[0].aliases.includes('group-hdr'), 'bare class alias');
  assert.ok(symbols[0].aliases.includes('.group-hdr'), 'dotted alias');
});

test('T03b: @media rules expand into individually-indexed inner selectors', (t) => {
  const { symbols } = parseCssBlock(
    '.topbar { top: 0; }\n@media (max-width:900px) { .topbar { position: static; } }\n', 1);
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('.topbar'), 'outer rule indexed');
  const inner = symbols.find(s => s.name.includes('@media') && s.name.includes('.topbar'));
  assert.ok(inner, 'inner media rule indexed with @media prefix');
  assert.equal(inner.startLine, 2, 'inner rule line maps to the original block');
});

test('T03c: standalone .css file indexed through the same path as inline styles', (t) => {
  const root = makeProject(t, {
    'style.css': '.btn-primary { color: blue; }\n',
    'page.html': '<p>no styles</p>',
  });
  const index = buildIndex(root);
  assert.ok(index.files['style.css'], '.css file recorded');
  const { matches } = nodeInfo(index, 'btn-primary');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'css-rule');
  assert.equal(matches[0].file, 'style.css');
});
