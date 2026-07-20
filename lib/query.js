'use strict';
const fs = require('fs');
const path = require('path');

// Per-symbol cap on returned source size — a handful of matches from a project
// with very long single lines (dense template-literal-building JS) can otherwise
// blow well past any tool-result token budget in one response.
const MAX_SOURCE_CHARS = 4000;

// Re-read the file fresh from disk on every call — never trust cached content,
// so returned source is always byte-for-byte current, same guarantee CodeGraph makes.
function readLines(absFile, startLine, endLine) {
  const text = fs.readFileSync(absFile, 'utf-8');
  const lines = text.split(/\r\n|\n/);
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  const out = [];
  for (let i = from; i <= to; i++) out.push(`${i}\t${lines[i - 1]}`);
  return out.join('\n');
}

// Truncate for display only — never used for the internal keyword-match check,
// so truncation can't cause false negatives in explore()'s scoring.
function truncateForDisplay(text) {
  if (text.length <= MAX_SOURCE_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_SOURCE_CHARS) + `\n... (truncated, ${text.length - MAX_SOURCE_CHARS} more chars — use indexgraph_node for the full symbol)`,
    truncated: true,
  };
}

// Query words: a handful of common English filler words carry no search signal
// and just dilute/inflate scores by matching almost every function body.
const STOPWORDS = new Set([
  'how', 'does', 'do', 'did', 'the', 'a', 'an', 'and', 'or', 'to', 'for', 'in', 'on',
  'with', 'of', 'is', 'are', 'it', 'this', 'that', 'what', 'which', 'work', 'works',
  'be', 'as', 'at', 'by', 'from', 'about',
]);

const CJK_RUN = /[\u{3400}-\u{9fff}]+/u;

// `\W` (used by a plain `split(/\W+/)`) only recognizes [A-Za-z0-9_] as "word"
// characters, so it treats any run of CJK text as pure separator — a query typed
// in Chinese silently loses every Chinese word before scoring even starts. Match
// ASCII identifier runs and CJK ideograph runs as separate token classes instead.
//
// A whole CJK run is kept as one token (helps short exact-phrase queries like
// "高新收入辅助账"), but a natural-language *question* in Chinese has no spaces
// between words either — filler words ("如何"/"在"/"里"/"做") fuse onto the real
// content words into one run that then matches nothing verbatim anywhere. There's
// no real word segmenter here, so fall back to overlapping 2-character bigrams
// for CJK runs too — the standard lightweight substitute (e.g. "高新收入" yields
// "高新"/"新收"/"收入", each independently matchable against shorter phrases in
// the code). Bigrams are weighted lower during scoring since they're noisier.
function tokenize(query) {
  const raw = String(query || '').toLowerCase().match(/[a-z0-9_]+|[\u{3400}-\u{9fff}]+/gu) || [];
  const words = [], bigrams = [];
  for (const tok of raw) {
    if (STOPWORDS.has(tok)) continue;
    if (CJK_RUN.test(tok)) {
      if (tok.length > 1) words.push(tok);
      for (let i = 0; i < tok.length - 1; i++) bigrams.push(tok.slice(i, i + 2));
    } else if (tok.length > 1) {
      words.push(tok);
    }
  }
  return { words, bigrams: [...new Set(bigrams)] };
}

function allSymbols(index) {
  const out = [];
  for (const [file, data] of Object.entries(index.files)) {
    for (const sym of data.symbols) out.push({ file, ...sym });
  }
  return out;
}

function findSymbol(index, name) {
  return allSymbols(index).filter(s => s.name === name);
}

function callersOf(index, name) {
  const out = [];
  for (const [file, data] of Object.entries(index.files)) {
    for (const e of data.edges) if (e.to === name) out.push({ file, from: e.from });
  }
  return out;
}

function calleesOf(index, name) {
  const out = [];
  for (const [file, data] of Object.entries(index.files)) {
    for (const e of data.edges) if (e.from === name) out.push({ file, to: e.to });
  }
  return out;
}

function nodeInfo(index, name) {
  const matches = findSymbol(index, name);
  if (!matches.length) return null;
  return matches.map(sym => {
    const absFile = path.join(index.root, sym.file);
    const { text, truncated } = truncateForDisplay(readLines(absFile, sym.startLine, sym.endLine));
    return {
      ...sym,
      absFile,
      source: text,
      truncated,
      callers: callersOf(index, name).filter(c => c.from !== name),
      callees: calleesOf(index, name),
    };
  });
}

function explore(index, query, limit) {
  limit = limit || 5;
  const { words, bigrams } = tokenize(query);
  if (!words.length && !bigrams.length) return [];

  // Body text is read per-symbol below but many symbols share a file — cache
  // each file's lines once per explore() call (never across calls, so results
  // still reflect on-disk content at query time, same guarantee as before).
  const fileLinesCache = new Map();
  function bodyTextOf(sym) {
    const absFile = path.join(index.root, sym.file);
    let lines = fileLinesCache.get(absFile);
    if (!lines) {
      try { lines = fs.readFileSync(absFile, 'utf-8').split(/\r\n|\n/); }
      catch (_) { lines = []; }
      fileLinesCache.set(absFile, lines);
    }
    const from = Math.max(1, sym.startLine), to = Math.min(lines.length, sym.endLine);
    let out = '';
    for (let i = from; i <= to; i++) out += lines[i - 1] + '\n';
    return out.toLowerCase();
  }

  const scored = [];
  for (const sym of allSymbols(index)) {
    const nameLower = sym.name.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (nameLower === w) score += 3;
      else if (nameLower.includes(w)) score += 2;
    }
    // Body text always contributes (previously this only ran when the name
    // matched nothing at all, so a symbol whose NAME partially matched could
    // never accrue the richer body-text signal and lost to unrelated symbols
    // whose bodies happened to contain more of the query's words).
    const body = bodyTextOf(sym);
    // CJK bigrams are a much noisier signal than a real word/identifier match
    // (a 2-character fragment turns up in all sorts of unrelated places), so
    // each hit counts for a fraction of a full word-match rather than +1.
    for (const bg of bigrams) if (body.includes(bg)) score += 0.34;
    for (const w of words) if (body.includes(w)) score += 1;
    if (score > 0) scored.push({ sym, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ sym }) => {
    const absFile = path.join(index.root, sym.file);
    const { text, truncated } = truncateForDisplay(readLines(absFile, sym.startLine, sym.endLine));
    return {
      ...sym,
      absFile,
      source: text,
      truncated,
      callers: callersOf(index, sym.name).filter(c => c.from !== sym.name),
      callees: calleesOf(index, sym.name),
    };
  });
}

module.exports = { findSymbol, callersOf, calleesOf, nodeInfo, explore, allSymbols };
