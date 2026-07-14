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
  const words = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = [];
  for (const sym of allSymbols(index)) {
    const nameLower = sym.name.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (nameLower === w) score += 3;
      else if (nameLower.includes(w)) score += 2;
    }
    if (score === 0) {
      // fall back to a cheap body-text check
      try {
        const absFile = path.join(index.root, sym.file);
        const body = readLines(absFile, sym.startLine, sym.endLine).toLowerCase();
        for (const w of words) if (body.includes(w)) score += 1;
      } catch (_) { /* ignore unreadable */ }
    }
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
