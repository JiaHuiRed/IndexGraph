'use strict';
const fs = require('fs');
const path = require('path');
// Namespaced (not destructured) require: tests intercept parse.parseBlock /
// parse.parseCssBlock on the module object to count real parse calls, which
// destructured bindings would silently bypass.
const parse = require('./parse');

const INDEX_DIR = '.indexgraph';
const INDEX_FILE = 'index.json';
// Bump when the on-disk shape changes so old indexes rebuild instead of being
// read with mismatched assumptions (v2: first schemaVersion-bearing shape;
// v3: adds uiElements — HTML/JSX UI nodes with event/class/text clues — so a
// v2 index cannot answer trace queries and must rebuild).
const SCHEMA_VERSION = 3;
// mtimes only survive a filesystem copy to ~0.5µs on NTFS (100ns resolution vs
// double-round-trip drift), so a strict !== rejects every copied-but-unchanged
// project and forces a pointless full rebuild. 2ms is far below any real
// edit-to-edit interval while absorbing all storage-precision noise.
const MTIME_TOLERANCE_MS = 2;

const SKIP_DIRS = new Set(['node_modules', '.git', '.indexgraph', '.codegraph', 'dist', 'build', '__pycache__', '.venv', 'venv', 'vendor']);

// Indexable sources: .html files (real markup + inline <script>/<style>),
// standalone .css files (one style block spanning the whole file), and
// frontend component files (.tsx/.jsx/.vue).
// The heavier parsers (parse5, typescript, @vue/compiler-sfc) are required
// lazily inside parseFileEntry: a CLI cold start on a plain HTML project must
// not pay for them (the MCP long-lived process amortizes the cost after the
// first parse).
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
        if (['.html', '.css', '.tsx', '.jsx', '.vue'].some(ext => lower.endsWith(ext))) out.push(full);
      }
    }
  })(root);
  return out;
}

// Assemble unique symbol ids and bind edge endpoints to them. parseBlock is a
// pure function (no filename knowledge), so the file-relative identity is
// attached here: `rel#startLine:col`. Same-name symbols in one file differ in
// position and therefore in id — callers/callees bind per symbol, never per
// name (IG-01).
//
// Unresolved candidate edges (cross-file calls parseBlock couldn't bind) only
// survive when the callee name is an actual project symbol somewhere in the
// index — otherwise every getElementById/console.log would flood the graph.
// `globalNames` is the set of all symbol names across the project; on
// incremental updates it comes from the existing index.
function attachIds(rel, entry) {
  for (const s of entry.symbols) s.id = `${rel}#${s.startLine}:${s.col}`;
  for (const e of entry.edges) {
    e.fromId = `${rel}#${e.fromKey}`;
    if (!e.unresolved) e.toId = `${rel}#${e.toKey}`;
  }
  // UI elements get ids in the same `rel#line:col` namespace as symbols
  // (positions never collide: one is a declaration start, the other a tag
  // start), and their component attribution resolves to a full symbol id here.
  for (const u of entry.uiElements || []) {
    u.id = `${rel}#${u.startLine}:${u.col}`;
    if (u.componentKey) u.componentId = `${rel}#${u.componentKey}`;
  }
}

// Unresolved candidate edges (cross-file calls parseBlock couldn't bind) only
// survive when the callee name is an actual project symbol somewhere in the
// index — otherwise every getElementById/console.log would flood the graph.
// Runs AFTER all changed files are parsed, so the global name set includes
// symbols introduced by the same update.
function filterUnresolvedEdges(entry, globalNames) {
  if (!globalNames) return;
  entry.edges = entry.edges.filter(e => !e.unresolved || globalNames.has(e.to));
}

function errMsg(e) { return String((e && e.message) || e); }

function parseFileEntry(root, file) {
  const rel = path.relative(root, file);
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; } // vanished mid-scan
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, symbols: [], edges: [], uiElements: [] };
  const addFrom = parsed => {
    entry.symbols = entry.symbols.concat(parsed.symbols);
    entry.edges = entry.edges.concat(parsed.edges);
    if (parsed.uiElements) entry.uiElements = entry.uiElements.concat(parsed.uiElements);
  };

  const lower = file.toLowerCase();
  const errors = [];
  try {
    if (lower.endsWith('.css')) {
      // Standalone stylesheet: the whole file is one style block starting at
      // line 1 — same rule parser as inline <style>.
      addFrom(parse.parseCssBlock(fs.readFileSync(file, 'utf-8'), 1));
    } else if (lower.endsWith('.html')) {
      // parse5 sees real markup, so a "<style>" inside a JS string can no
      // longer masquerade as a style block; UI elements (tags with id/class/
      // text/event clues) are recorded alongside the script/style blocks.
      const parseUiHtml = require('./parse-ui-html');
      const html = fs.readFileSync(file, 'utf-8');
      const doc = parseUiHtml.parseHtmlDocument(html);
      for (const block of doc.scriptBlocks) {
        try { addFrom(parse.parseBlock(block.content, block.startLine)); }
        catch (e) { errors.push(`script@${block.startLine}: ${errMsg(e)}`); }
      }
      for (const block of doc.styleBlocks) {
        try { addFrom(parse.parseCssBlock(block.content, block.startLine)); }
        catch (e) { errors.push(`style@${block.startLine}: ${errMsg(e)}`); }
      }
      entry.uiElements = entry.uiElements.concat(doc.uiElements);
    } else if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
      // One parse covers everything the file offers: symbols (components
      // included), call edges and UI elements.
      const { parseTsModule } = require('./parse-ui-tsx');
      const ts = require('typescript');
      const kind = lower.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
      addFrom(parseTsModule(fs.readFileSync(file, 'utf-8'), kind));
    } else if (lower.endsWith('.vue')) {
      // SFC: script blocks through the TS parser, template → UI elements,
      // each <style> block through the CSS rule parser (same isolation as
      // HTML blocks: one broken style never takes the script symbols down).
      const { parseVueSfc } = require('./parse-ui-vue');
      const componentName = path.basename(file, path.extname(file));
      const parsed = parseVueSfc(fs.readFileSync(file, 'utf-8'), componentName);
      addFrom(parsed);
      for (const block of parsed.styleBlocks || []) {
        try { addFrom(parse.parseCssBlock(block.content, block.startLine)); }
        catch (e) { errors.push(`style@${block.startLine}: ${errMsg(e)}`); }
      }
      if (parsed.parseErrors && parsed.parseErrors.length) errors.push(...parsed.parseErrors);
    }
  } catch (e) {
    entry.parseError = `read: ${errMsg(e)}`;
  }
  if (errors.length) entry.parseError = errors.join('\n');

  attachIds(rel, entry); // unresolved filtering is deferred (needs global names)
  return [rel, entry];
}

function collectSymbolNames(index, extraEntries) {
  const names = new Set();
  for (const data of Object.values(index.files)) for (const s of data.symbols) names.add(s.name);
  for (const entry of extraEntries || []) for (const s of entry.symbols) names.add(s.name);
  return names;
}

function buildIndex(root) {
  const index = { schemaVersion: SCHEMA_VERSION, root: path.resolve(root), builtAt: Date.now(), files: {} };
  const scanned = [];
  for (const file of findIndexableFiles(root)) {
    const parsed = parseFileEntry(root, file);
    if (parsed) scanned.push(parsed);
  }
  const globalNames = collectSymbolNames(index, scanned.map(([, e]) => e));
  for (const [rel, entry] of scanned) {
    filterUnresolvedEdges(entry, globalNames);
    index.files[rel] = entry;
  }
  return index;
}

function savedIndexPath(root) { return path.join(root, INDEX_DIR, INDEX_FILE); }

// Distinguishes "never initialized" from "index file exists (maybe broken)"
// for entry points (IG08-F01): the MCP/CLI existence pre-check used
// loadIndex(), whose null-on-corrupt made a damaged cache look uninitialized
// and blocked the self-heal rebuild. Only ENOENT means missing; real IO
// failures (permissions, disk) still throw instead of masquerading as "no
// index".
function indexFileState(root) {
  try { fs.statSync(savedIndexPath(root)); return 'exists'; } catch (e) {
    if (e && e.code === 'ENOENT') return 'missing';
    throw e;
  }
}

// Atomic save: write to a uniquely-named temp file in the same directory, then
// rename over the target. A crash mid-write can never leave a truncated
// index.json behind (IG-07); the unique name keeps concurrent CLI/MCP
// processes from clobbering each other's temp file.
function saveIndex(root, index) {
  const dir = path.join(root, INDEX_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${INDEX_FILE}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, JSON.stringify(index));
  try {
    fs.renameSync(tmp, savedIndexPath(root));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* best-effort cleanup */ }
    throw e; // disk-full / permission errors must surface, not vanish
  }
  // A successful write changes the file's stat — drop any cached parse of the
  // previous content so the next loadIndex re-reads what is on disk now (a
  // save by another process lands here too: its stat differs, cache misses).
  parsedIndexCache.delete(path.resolve(root));
}

// Parsed-index cache for long-lived processes (the MCP server): loadIndex sits
// on the hot path of every tool call, and re-parsing a multi-MB index.json per
// request dominated it (measured: ~30ms at 9k symbols, linear in index size).
// Keyed by the index file's mtime+size — any write, ours or another process's,
// changes the stat and forces a fresh read. Entries are only ever populated
// from a verified on-disk parse and dropped inside saveIndex, so a mutated
// index object is never served under a stat it no longer matches.
const parsedIndexCache = new Map(); // resolved root -> { key, index }

// Missing file → null (nothing indexed yet). Corrupt JSON → warn on stderr and
// return null so ensureFresh treats it as "no index" and rebuilds — a corrupt
// cache must not leave the MCP server permanently broken (IG-07). Any other
// read failure (permissions, disk) still throws: those are not recoverable
// by rebuilding.
function loadIndex(root) {
  const file = savedIndexPath(root);
  const cacheKey = path.resolve(root);
  let stat;
  try { stat = fs.statSync(file); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const statKey = `${stat.mtimeMs}:${stat.size}`;
  const hit = parsedIndexCache.get(cacheKey);
  if (hit && hit.key === statKey) return hit.index;

  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  let index;
  try { index = JSON.parse(raw); } catch (e) {
    console.error(`[indexgraph] ${file} is corrupt (${e.message}) — rebuilding`);
    return null;
  }
  parsedIndexCache.set(cacheKey, { key: statKey, index });
  return index;
}

// Compare a file's current stat against its index entry. mtime is compared
// with a small tolerance (storage-precision noise, see MTIME_TOLERANCE_MS);
// size is an exact second signal.
function entryMatchesStat(entry, stat) {
  return Math.abs(stat.mtimeMs - entry.mtimeMs) <= MTIME_TOLERANCE_MS && stat.size === entry.size;
}

// Diff the on-disk file set against the index — stat only, never parses file
// bodies. Zero-symbol files are recorded in the index, so a brand-new file
// with no indexable content still shows up here as `added` exactly once and
// never again (v1 re-parsed every unindexed file on every query).
function scanDiff(root, index) {
  const diff = { added: [], changed: [], deleted: [] };
  if (!index || !index.files) return diff;
  const current = findIndexableFiles(root);
  const currentRel = new Set(current.map(f => path.relative(root, f)));
  for (const f of current) {
    const rel = path.relative(root, f);
    const entry = index.files[rel];
    let stat;
    try { stat = fs.statSync(f); } catch (_) { continue; } // vanished mid-scan
    if (!entry) diff.added.push(rel);
    else if (!entryMatchesStat(entry, stat)) diff.changed.push(rel);
  }
  for (const rel of Object.keys(index.files)) {
    if (!currentRel.has(rel)) diff.deleted.push(rel);
  }
  return diff;
}

// True if the index can't be used as-is: wrong shape/version, saved for a
// different project root (copied/moved workspace — reading the old absolute
// root would silently serve another project's source, IG-02), or any file
// added/changed/deleted since the build.
function isStale(root, index) {
  if (!index || !index.files) return true;
  if (index.schemaVersion !== SCHEMA_VERSION) return true;
  if (!index.root || path.resolve(index.root) !== path.resolve(root)) return true;
  const diff = scanDiff(root, index);
  return diff.added.length > 0 || diff.changed.length > 0 || diff.deleted.length > 0;
}

// Load the on-disk index, transparently rebuilding it first if anything
// indexed has changed since it was built — CLI and MCP callers get current
// results without needing to remember to re-run `indexgraph init`.
//
// Rebuild strategy: a full rescan-and-parse when the index shape itself is
// unusable (missing, wrong schema version, foreign root); otherwise an
// incremental update that reparses only the files scanDiff reported.
function ensureFresh(root, opts) {
  opts = opts || {};
  let index = loadIndex(root);
  const usableShape = index && index.schemaVersion === SCHEMA_VERSION &&
      index.root && path.resolve(index.root) === path.resolve(root);
  if (usableShape) {
    const diff = scanDiff(root, index);
    if (diff.added.length || diff.changed.length || diff.deleted.length) {
      // The loaded index is treated as IMMUTABLE from here on: loadIndex may
      // hand the very same object to the next call (parsed cache), and
      // lib/query caches derived lookup tables against object identity.
      // Update a shallow copy instead — only the files map is mutated, and
      // its entries are replaced whole (parseFileEntry builds new ones),
      // never edited in place.
      index = { ...index, files: { ...index.files } };
      for (const rel of diff.deleted) delete index.files[rel];
      const reparsed = new Map();
      for (const rel of [...diff.added, ...diff.changed]) {
        const parsed = parseFileEntry(root, path.join(root, rel));
        if (parsed) reparsed.set(rel, parsed[1]);
        else delete index.files[rel]; // vanished between scan and reparse
      }
      // Global name set AFTER the reparse, so a candidate edge may point at a
      // symbol introduced by this very update.
      const globalNames = collectSymbolNames(index, [...reparsed.values()]);
      for (const [rel, entry] of reparsed) {
        filterUnresolvedEdges(entry, globalNames);
        index.files[rel] = entry;
      }
      index.builtAt = Date.now();
      saveIndex(root, index);
      if (opts.onRebuild) opts.onRebuild(index);
    }
    return index;
  }
  // Missing, corrupt, wrong schema version, or a foreign root: rebuild from
  // scratch (and the rebuilt index points at the current root).
  index = buildIndex(root);
  saveIndex(root, index);
  if (opts.onRebuild) opts.onRebuild(index);
  return index;
}

module.exports = { buildIndex, saveIndex, loadIndex, findIndexableFiles, scanDiff, isStale, ensureFresh, indexFileState, savedIndexPath, SCHEMA_VERSION };
