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
  const index = { root: path.resolve(root), builtAt: null, files: {} };
  for (const file of files) {
    const rel = path.relative(root, file);
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
    if (symbols.length) index.files[rel] = { symbols, edges };
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

module.exports = { buildIndex, saveIndex, loadIndex, findHtmlFiles };
