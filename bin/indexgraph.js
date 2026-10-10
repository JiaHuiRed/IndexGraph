#!/usr/bin/env node
'use strict';
const path = require('path');
const { buildIndex, saveIndex, findIndexableFiles, ensureFresh, indexFileState } = require('../lib/index-store');
const { nodeInfo, explore, allSymbols } = require('../lib/query');
const pkg = require('../package.json');

function requireIndex(root) {
  // Only a genuinely MISSING index file asks for init; an existing but
  // corrupt/incompatible one goes through ensureFresh and self-heals
  // (IG08-F01 — the old loadIndex() pre-check turned corrupt into "not found").
  if (indexFileState(root) === 'missing') {
    console.error(`[ERR] no .indexgraph index found in ${root} — run "indexgraph init" first`);
    process.exit(1);
  }
  return ensureFresh(root, {
    onRebuild: () => console.error('[indexgraph] index was stale, rebuilt automatically'),
  });
}

function printSymbolBlock(s) {
  console.log(`\n**${s.name}** (${s.kind}) — ${s.file}:${s.startLine}`);
  console.log('```' + (s.kind.startsWith('css') ? 'css' : 'javascript'));
  console.log(s.source);
  console.log('```');
  if (s.callers.length) console.log('Called by ← ' + s.callers.map(c => `${c.from} (${c.file})`).join(', '));
  if (s.callees.length) {
    // Unresolved cross-file candidates get a trailing `?` — never a certain edge.
    const callees = s.callees.map(c => `${c.unresolved ? c.to + '?' : c.to} (${c.file})`).join(', ');
    const more = s.calleesTruncated ? ' …(+more)' : '';
    console.log('Calls    → ' + callees + more);
  }
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
    const srcFiles = findIndexableFiles(target);
    console.log(`Scanning ${target} — ${srcFiles.length} .html/.css file(s) found`);
    const index = buildIndex(target);
    saveIndex(target, index);
    const fileCount = Object.keys(index.files).length;
    const allSyms = Object.values(index.files).flatMap(f => f.symbols);
    const cssCount = allSyms.filter(s => s.kind.startsWith('css')).length;
    const edgeCount = Object.values(index.files).reduce((n, f) => n + f.edges.length, 0);
    console.log(`Indexed ${fileCount} file(s) (.html inline blocks + standalone .css) — ${allSyms.length} symbols (${cssCount} CSS rules), ${edgeCount} call edges`);
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
    if (!name) { console.error('usage: indexgraph node <symbolName> [file]'); process.exit(1); }
    const index = requireIndex(root);
    // Optional second arg: a file filter to disambiguate same-name symbols.
    const fileArg = rest[1];
    const result = nodeInfo(index, name, 1, fileArg ? { file: fileArg } : {});
    if (!result) { console.log(`Symbol "${name}" not found in the index`); return; }
    const { matches, omitted } = result;
    matches.forEach(printSymbolBlock);
    if (omitted.length) {
      console.log(`\n(+${omitted.length} more same-name match(es) omitted — re-run with the file argument: ` +
        omitted.map(o => `${o.file}:${o.startLine}`).join(', ') + ')');
    }
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

  console.log(`indexgraph v${pkg.version} — frontend (HTML <script>/<style>) code graph, CodeGraph-style

Usage:
  indexgraph init [path]        Scan .html/.css files, extract inline <script>/<style>, build the index
  indexgraph files              List indexed files and symbol counts
  indexgraph node <name> [file]  Exact symbol: source + callers + callees (JS function name or CSS selector/class/id)
  indexgraph explore "<query>"  Keyword search across symbol names / bodies
  indexgraph version            Print version
`);
}

main();
