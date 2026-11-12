#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const { buildIndex, saveIndex, findIndexableFiles, ensureFresh, indexFileState, savedIndexPath } = require('../lib/index-store');
const { nodeInfo, explore, allSymbols } = require('../lib/query');
const { trace, formatTrace } = require('../lib/ui-trace');
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
    console.log(`Scanning ${target} — ${srcFiles.length} indexable file(s) found (.html/.css/.js/.mjs/.cjs/.tsx/.jsx/.vue)`);
    const index = buildIndex(target);
    saveIndex(target, index);
    const fileCount = Object.keys(index.files).length;
    const allSyms = Object.values(index.files).flatMap(f => f.symbols);
    const cssCount = allSyms.filter(s => s.kind.startsWith('css')).length;
    const uiCount = Object.values(index.files).reduce((n, f) => n + (f.uiElements || []).length, 0);
    const edgeCount = Object.values(index.files).reduce((n, f) => n + f.edges.length, 0);
    console.log(`Indexed ${fileCount} file(s) — ${allSyms.length} symbols (${cssCount} CSS rules), ${edgeCount} call edges, ${uiCount} UI elements`);
    return;
  }

  if (cmd === 'files') {
    const index = requireIndex(root);
    // Largest files first — on a many-file project this is the useful order.
    const rows = Object.entries(index.files)
      .sort((a, b) => b[1].symbols.length - a[1].symbols.length || a[0].localeCompare(b[0]));
    for (const [file, data] of rows) {
      console.log(`${file}  (${data.symbols.length} symbols, ${data.edges.length} edges)`);
    }
    return;
  }

  // Human-readable summary of the on-disk index. index.json is a compact
  // machine format (single line by design) — this is the inspection entry point.
  if (cmd === 'stats') {
    const index = requireIndex(root);
    const files = Object.entries(index.files);
    const symbols = files.flatMap(([, data]) => data.symbols);
    const edges = files.reduce((n, [, data]) => n + data.edges.length, 0);
    const kinds = symbols.reduce((acc, s) => {
      acc[s.kind] = (acc[s.kind] || 0) + 1;
      return acc;
    }, {});
    const css = files.filter(([file]) => file.toLowerCase().endsWith('.css')).length;
    console.log(`Index graph — ${index.root}`);
    console.log(`  schema:  ${index.schemaVersion}`);
    console.log(`  built:   ${new Date(index.builtAt).toLocaleString()}`);
    console.log(`  files:   ${files.length} (${files.length - css} .html, ${css} .css)`);
    console.log(`  symbols: ${symbols.length}`);
    for (const [kind, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${kind}: ${n}`);
    }
    console.log(`  edges:   ${edges}`);
    console.log(`  on disk: ${(fs.statSync(savedIndexPath(root)).size / 1024).toFixed(1)} KB (.indexgraph/index.json, compact)`);
    return;
  }

  // Raw inspection: the exact object the query side reads, pretty-printed.
  // Redirect it to a file when you actually want to browse the whole thing.
  if (cmd === 'dump') {
    console.log(JSON.stringify(requireIndex(root), null, 2));
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

  if (cmd === 'trace') {
    // indexgraph trace --text "保存设置" --class settings-save --id save-btn
    //                 --component Panel --selector "button.save" --tag button
    //                 --file src/x.tsx --limit 5 --depth 1
    const clueNames = { '--text': 'text', '--class': 'className', '--id': 'id', '--component': 'component', '--selector': 'selector', '--tag': 'tag' };
    const clues = {};
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (clueNames[a]) clues[clueNames[a]] = rest[++i];
      else if (a === '--file') opts.file = rest[++i];
      else if (a === '--limit') opts.limit = Number(rest[++i]);
      else if (a === '--depth') opts.depth = Number(rest[++i]);
      else { console.error(`unknown trace argument: ${a}`); process.exit(1); }
    }
    const index = requireIndex(root);
    const result = trace(index, clues, opts);
    console.log(formatTrace(result));
    return;
  }

  console.log(`indexgraph v${pkg.version} — frontend (HTML <script>/<style>) code graph, CodeGraph-style

Usage:
  indexgraph init [path]        Scan .html/.css/.js/.mjs/.cjs/.tsx/.jsx/.vue files, extract inline <script>/<style> + UI elements, build the index
  indexgraph files              List indexed files and symbol counts (largest first)
  indexgraph stats              Summarize the index: files, symbols by kind, edges, on-disk size
  indexgraph dump               Print the raw index as pretty JSON (redirect to a file to browse)
  indexgraph node <name> [file]  Exact symbol: source + callers + callees (JS function name or CSS selector/class/id)
  indexgraph explore "<query>"  Keyword search across symbol names / bodies
  indexgraph trace              UI trace: --text/--class/--id/--component/--selector/--tag [--file] [--limit] [--depth]
  indexgraph version            Print version
`);
}

main();
