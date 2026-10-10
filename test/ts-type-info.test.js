'use strict';
// T09 — IG-06: nearest-tsconfig search for monorepos and bounded service cache.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { findNearestTsConfig, getTypeInfo } = require('../lib/ts-type-info');
const { makeProject } = require('./helpers');

test('T09a: nearest tsconfig is found from the file directory, not the root', (t) => {
  const root = makeProject(t, {
    'packages/app/tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    'packages/app/src/x.ts': 'export const n = 1;\n',
    'packages/lib/src/y.ts': 'export const m = 2;\n',
    'tsconfig.json': '{ "compilerOptions": { "strict": false } }',
  });
  const fileInApp = path.join(root, 'packages', 'app', 'src', 'x.ts');
  const found = findNearestTsConfig(root, fileInApp);
  assert.equal(found, path.join(root, 'packages', 'app', 'tsconfig.json'));

  // lib has no own tsconfig — the walk climbs past it to the root config.
  const fileInLib = path.join(root, 'packages', 'lib', 'src', 'y.ts');
  assert.equal(findNearestTsConfig(root, fileInLib), path.join(root, 'tsconfig.json'));
});

test('T09b: no tsconfig anywhere falls back to null (fallback options)', (t) => {
  const root = makeProject(t, { 'src/x.ts': 'export const n = 1;\n' });
  assert.equal(findNearestTsConfig(root, path.join(root, 'src', 'x.ts')), null);
});

test('T09c: hover inside a strict sub-package reflects that package config', (t) => {
  // A strict sub-config makes an implicit-any parameter an error; a
  // non-strict root config wouldn't. The quick-info for the parameter must
  // come from the NEAREST config (type `any` is reported under strict).
  const root = makeProject(t, {
    'tsconfig.json': '{ "compilerOptions": { "target": "es2020" } }',
    'packages/app/tsconfig.json': '{ "compilerOptions": { "target": "es2020", "strict": true, "noImplicitAny": true } }',
    'packages/app/src/x.ts': 'export function greet(who) { return "hi " + who; }\n',
  });
  const info = getTypeInfo({
    projectPath: root,
    file: 'packages/app/src/x.ts',
    line: 1,
    column: 24, // the `who` parameter
  });
  assert.ok(info.type, 'quick info returned');
  assert.match(info.type, /any/, 'noImplicitAny (nearest config) types the param as any');
});
