'use strict';
const fs = require('fs');
const path = require('path');
const { extractScripts, extractStyles } = require('./extract');
const { parseBlock, parseCssBlock } = require('./parse');

const INDEX_DIR = '.indexgraph';
const INDEX_FILE = 'index.json';

const SKIP_DIRS = new Set(['node_modules', '.git', '.indexgraph', '.codegraph', 'dist', 'build', '__pycache__', '.venv', 'venv', 'vendor']);

// Indexable sources: .html files (inline <script>/<style> blocks) and
// standalone .css files — the latter are one style block spanning the whole
// file, so the same CSS rule parser handles them with no extra machinery.
function findIndexableFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const lower = e.name.toLowerCase();
        if (lower.endsWith('.html') || lower.endsWith('.css')) out.push(full);
      }
    }
  })(root);
  return out;
}

function buildIndex(root) {
  const files = findIndexableFiles(root);
  const index = { root: path.resolve(root), builtAt: Date.now(), files: {} };
  for (const file of files) {
    const rel = path.relative(root, file);
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { continue; } // file vanished mid-scan
    let symbols = [], edges = [];
    if (file.toLowerCase().endsWith('.css')) {
      // Standalone stylesheet: the whole file is one style block starting at
      // line 1 — same rule parser as inline <style>.
      try {
        symbols = parseCssBlock(fs.readFileSync(file, 'utf-8'), 1).symbols;
      } catch (e) { continue; }
    } else {
      const scriptBlocks = extractScripts(file);
      const styleBlocks = extractStyles(file);
      for (const block of scriptBlocks) {
        let parsed;
        try { parsed = parseBlock(block.content, block.startLine); }
        catch (e) { continue; } // skip blocks that fail to parse (e.g. template literals acorn chokes on, non-JS script types)
        symbols = symbols.concat(parsed.symbols);
        edges = edges.concat(parsed.edges);
      }
      for (const block of styleBlocks) {
        let parsed;
        try { parsed = parseCssBlock(block.content, block.startLine); }
        catch (e) { continue; }
        symbols = symbols.concat(parsed.symbols);
      }
    }
    if (symbols.length) index.files[rel] = { symbols, edges, mtimeMs };
  }
  return index;
}

function savedIndexPath(root) { return path.join(root, INDEX_DIR, INDEX_FILE); }

function saveIndex(root, index) {
  const dir = path.join(root, INDEX_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(savedIndexPath(root), JSON.stringify(index, null, 0));
}

function loadIndex(root) {
  const p = savedIndexPath(root);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// True if any indexed file was modified/deleted, or any new .html/.css file
// with indexable content appeared, since the index was built — compares current
// mtimes against what was recorded at build time (cheap: stat only, no parse).
function isStale(root, index) {
  if (!index || !index.files) return true;
  const current = findIndexableFiles(root);
  const currentRel = new Set(current.map(f => path.relative(root, f)));
  const indexedRel = Object.keys(index.files);

  for (const rel of indexedRel) {
    if (!currentRel.has(rel)) return true; // indexed file was deleted/renamed
    const abs = path.join(root, rel);
    let mtimeMs;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch (_) { return true; }
    if (mtimeMs !== index.files[rel].mtimeMs) return true; // modified since build
  }
  for (const f of current) {
    const rel = path.relative(root, f);
    if (!(rel in index.files)) {
      // A file with no inline <script>/<style> legitimately produces no entry
      // (see buildIndex), so a brand-new file only counts as staleness if it
      // now parses to at least one symbol.
      if (f.toLowerCase().endsWith('.css')) {
        try {
          if (parseCssBlock(fs.readFileSync(f, 'utf-8'), 1).symbols.length) return true;
        } catch (_) { /* unparsable file, doesn't affect staleness */ }
        continue;
      }
      const scriptBlocks = extractScripts(f);
      for (const block of scriptBlocks) {
        try { if (parseBlock(block.content, block.startLine).symbols.length) return true; }
        catch (_) { /* unparsable block, doesn't affect staleness */ }
      }
      const styleBlocks = extractStyles(f);
      for (const block of styleBlocks) {
        try { if (parseCssBlock(block.content, block.startLine).symbols.length) return true; }
        catch (_) { /* unparsable block, doesn't affect staleness */ }
      }
    }
  }
  return false;
}

// Load the on-disk index, transparently rebuilding it first if anything
// indexed has changed since it was built — CLI and MCP callers get current
// results without needing to remember to re-run `indexgraph init`.
function ensureFresh(root, opts) {
  opts = opts || {};
  let index = loadIndex(root);
  if (!index || isStale(root, index)) {
    index = buildIndex(root);
    saveIndex(root, index);
    if (opts.onRebuild) opts.onRebuild(index);
  }
  return index;
}

module.exports = { buildIndex, saveIndex, loadIndex, findIndexableFiles, isStale, ensureFresh };
