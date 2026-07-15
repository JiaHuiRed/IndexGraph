'use strict';
const fs = require('fs');
const path = require('path');
const { extractScripts } = require('./extract');
const { parseBlock } = require('./parse');

const INDEX_DIR = '.indexgraph';
const INDEX_FILE = 'index.json';

const SKIP_DIRS = new Set(['node_modules', '.git', '.indexgraph', '.codegraph', 'dist', 'build', '__pycache__', '.venv', 'venv', 'vendor']);

function findHtmlFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.html')) out.push(full);
    }
  })(root);
  return out;
}

function buildIndex(root) {
  const files = findHtmlFiles(root);
  const index = { root: path.resolve(root), builtAt: Date.now(), files: {} };
  for (const file of files) {
    const rel = path.relative(root, file);
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { continue; } // file vanished mid-scan
    const blocks = extractScripts(file);
    if (!blocks.length) continue;
    let symbols = [], edges = [];
    for (const block of blocks) {
      let parsed;
      try { parsed = parseBlock(block.content, block.startLine); }
      catch (e) { continue; } // skip blocks that fail to parse (e.g. template literals acorn chokes on, non-JS script types)
      symbols = symbols.concat(parsed.symbols);
      edges = edges.concat(parsed.edges);
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

// True if any indexed file was modified/deleted, or any new .html file with
// inline <script> appeared, since the index was built — compares current
// mtimes against what was recorded at build time (cheap: stat only, no parse).
function isStale(root, index) {
  if (!index || !index.files) return true;
  const current = findHtmlFiles(root);
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
      // A file with no inline <script> legitimately produces no entry (see
      // buildIndex), so a brand-new file only counts as staleness if it now
      // parses to at least one symbol.
      const blocks = extractScripts(f);
      for (const block of blocks) {
        try { if (parseBlock(block.content, block.startLine).symbols.length) return true; }
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

module.exports = { buildIndex, saveIndex, loadIndex, findHtmlFiles, isStale, ensureFresh };
