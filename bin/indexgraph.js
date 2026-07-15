#!/usr/bin/env node
'use strict';
const path = require('path');
const { buildIndex, saveIndex, loadIndex, findHtmlFiles, ensureFresh } = require('../lib/index-store');
const { nodeInfo, explore, allSymbols } = require('../lib/query');
const pkg = require('../package.json');

function requireIndex(root) {
  const before = loadIndex(root);
  if (!before) {
    console.error(`[ERR] no .indexgraph index found in ${root} — run "indexgraph init" first`);
    process.exit(1);
  }
  return ensureFresh(root, {
    onRebuild: () => console.error('[indexgraph] index was stale, rebuilt automatically'),
  });
}

function printSymbolBlock(s) {
  console.log(`\n**${s.name}** (${s.kind}) — ${s.file}:${s.startLine}`);
  console.log('```javascript');
  console.log(s.source);
  console.log('```');
  if (s.callers.length) console.log('Called by ← ' + s.callers.map(c => `${c.from} (${c.file})`).join(', '));
  if (s.callees.length) console.log('Calls    → ' + s.callees.map(c => `${c.to} (${c.file})`).join(', '));
}

function main() {
  const [, , cmd, ...rest] = process.argv;
  const root = process.cwd();

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    console.log(pkg.version);
    return;
  }

  if (cmd === 'init') {
    const target = rest[0] ? path.resolve(rest[0]) : root;
    const htmlFiles = findHtmlFiles(target);
    console.log(`Scanning ${target} — ${htmlFiles.length} .html file(s) found`);
    const index = buildIndex(target);
    saveIndex(target, index);
    const fileCount = Object.keys(index.files).length;
    const symCount = Object.values(index.files).reduce((n, f) => n + f.symbols.length, 0);
    const edgeCount = Object.values(index.files).reduce((n, f) => n + f.edges.length, 0);
    console.log(`Indexed ${fileCount} file(s) with inline <script> — ${symCount} symbols, ${edgeCount} call edges`);
    return;
  }

  if (cmd === 'files') {
    const index = requireIndex(root);
    for (const [file, data] of Object.entries(index.files)) {
      console.log(`${file}  (${data.symbols.length} symbols, ${data.edges.length} edges)`);
    }
    return;
  }

  if (cmd === 'node') {
    const name = rest[0];
    if (!name) { console.error('usage: indexgraph node <symbolName>'); process.exit(1); }
    const index = requireIndex(root);
    const matches = nodeInfo(index, name);
    if (!matches) { console.log(`Symbol "${name}" not found in the index`); return; }
    matches.forEach(printSymbolBlock);
    return;
  }

  if (cmd === 'explore') {
    const query = rest.join(' ');
    if (!query) { console.error('usage: indexgraph explore "<query>"'); process.exit(1); }
    const index = requireIndex(root);
    const results = explore(index, query);
    if (!results.length) { console.log(`No matches for "${query}"`); return; }
    console.log(`Found ${results.length} matching symbol(s) for "${query}"`);
    results.forEach(printSymbolBlock);
    return;
  }

  console.log(`indexgraph v${pkg.version} — frontend (HTML <script>) code graph, CodeGraph-style

Usage:
  indexgraph init [path]        Scan for .html files, extract inline <script>, build the index
  indexgraph files              List indexed files and symbol counts
  indexgraph node <name>        Exact symbol: source + callers + callees
  indexgraph explore "<query>"  Keyword search across symbol names / bodies
  indexgraph version            Print version
`);
}

main();
