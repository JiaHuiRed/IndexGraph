'use strict';
const fs = require('fs');
const path = require('path');

// Per-symbol cap on returned source size — a handful of matches from a project
// with very long single lines (dense template-literal-building JS) can otherwise
// blow well past any tool-result token budget in one response.
const MAX_SOURCE_CHARS = 4000;
// explore() 的结果不是"我要精确定位这个函数"，而是"看看哪些函数沾边"——
// 完整源码只会撑爆响应，签名前几行 + 调用链才是探索时真正需要的，给个小额度
const MAX_EXPLORE_SOURCE_CHARS = 800;

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
function truncateForDisplay(text, maxChars = MAX_SOURCE_CHARS) {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + `\n... (truncated, ${text.length - maxChars} more chars — use indexgraph_node for the full symbol)`,
    truncated: true,
  };
}

// Count every occurrence of `token` in `text` (not just a boolean contains).
// Used for body scoring — a function whose body mentions the query word 5 times
// is far more on-topic than one that mentions it once in passing.
function countHits(text, token) {
  let n = 0, idx = 0;
  while ((idx = text.indexOf(token, idx)) !== -1) { n++; idx += token.length; }
  return n;
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
  // CSS-rule symbols also carry `aliases` (bare class/id names, comma-branch
  // selectors) so a query like "group-hdr" finds a rule whose full name is
  // the compound selector "table.rec-table th.group-hdr". JS symbols have no
  // aliases field, so this is a no-op for them — exact name match only.
  return allSymbols(index).filter(s => s.name === name || (s.aliases && s.aliases.includes(name)));
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

// Collect callers/callees to `depth` levels. Level 1 = direct edges.
// Deeper levels are the direct edges of each symbol found at the previous
// level, flattened and deduped — the result stays a flat list (with the
// `level` field marking how many hops out each symbol sits), never nested,
// so the MCP text output stays readable.
function collectEdges(index, name, direction, depth) {
  const out = [];
  const seen = new Set();
  let frontier = [name];
  for (let level = 1; level <= depth; level++) {
    const next = [];
    for (const fn of frontier) {
      const edges = direction === 'callers' ? callersOf(index, fn) : calleesOf(index, fn);
      for (const e of edges) {
        const other = direction === 'callers' ? e.from : e.to;
        if (other === name) continue; // self-loops aren't informative
        const key = other + '@' + level;
        if (!seen.has(key)) { seen.add(key); out.push({ name: other, file: e.file, level }); }
        next.push(other);
      }
    }
    frontier = next;
  }
  return out;
}

function nodeInfo(index, name, depth = 1) {
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
      callers: depth > 1
        ? collectEdges(index, name, 'callers', depth).filter(c => c.name !== name)
        : callersOf(index, name).filter(c => c.from !== name),
      callees: depth > 1
        ? collectEdges(index, name, 'callees', depth).filter(c => c.name !== name)
        : calleesOf(index, name),
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
    // Template-builder functions (renderXxxHtml / buildXxx) embed the page's
    // button labels and tooltips inside HTML tags, so their bodies "mention"
    // every feature keyword in the app and crowd out the functions that actually
    // implement the feature. Strip tags before matching — comments and JS string
    // literals survive, button text/title attributes do not.
    return out.toLowerCase().replace(/<[^>]*>/g, ' ');
  }

  // Scoring weights. Words (whole identifiers/CJK phrases) are counted per
  // occurrence — a function that mentions the query word 5 times is far more
  // on-topic than one that mentions it once. Bigrams, by contrast, are noise-
  // heavy (a 2-char fragment turns up everywhere, and template loops can repeat
  // the same button label 20 times in one function body), so each bigram
  // counts at most once per function: "does this function mention this fragment
  // at all", not "how many times". Body score is then lightly dampened by
  // length so 500-line functions can't dominate via sheer surface area.
  const NAME_EXACT = 6, NAME_PARTIAL = 3, BODY_WORD = 1, BODY_BIGRAM = 0.5;
  const MAX_WORD_HITS = 5;            // per-word cap, so a 2000-line file can't run away
  const MAX_UNIQUE_BIGRAMS = 4;       // beyond ~4 distinct fragments adds no signal
  const CALL_PROPAGATION = 0.2;       // caller bonus from callee's score (call-graph relevance)
  // Template-builder functions (renderXxxHtml / buildXxx) embed the page's
  // button labels and tooltips as text between HTML tags, so their bodies
  // "mention" every feature keyword in the app and crowd out the functions
  // that actually implement the feature. Tags themselves are stripped for
  // matching, but the inter-tag text survives — dampen the body score of
  // functions whose name marks them as template builders. (Name check only:
  // after tag-stripping a body rarely contains a bare '<', so that as a
  // condition would silently disable the damp.)
  const BUILDER_NAME = /(render|build|rowhtml|formhtml|tablehtml)/i;
  const BUILDER_BODY_DAMP = 0.3;

  const scored = [];
  for (const sym of allSymbols(index)) {
    const nameLower = sym.name.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (nameLower === w) score += NAME_EXACT;
      else if (nameLower.includes(w)) score += NAME_PARTIAL;
    }
    // Body text always contributes (previously this only ran when the name
    // matched nothing at all, so a symbol whose NAME partially matched could
    // never accrue the richer body-text signal and lost to unrelated symbols
    // whose bodies happened to contain more of the query's words).
    const body = bodyTextOf(sym);
    let wordHits = 0;
    for (const w of words) wordHits += Math.min(countHits(body, w), MAX_WORD_HITS) * BODY_WORD;
    let uniqBigrams = 0;
    for (const bg of bigrams) if (body.includes(bg)) uniqBigrams++;
    let bodyScore = wordHits + Math.min(uniqBigrams, MAX_UNIQUE_BIGRAMS) * BODY_BIGRAM;
    if (BUILDER_NAME.test(sym.name)) bodyScore *= BUILDER_BODY_DAMP;
    score += bodyScore / Math.pow(1 + body.length / 4000, 0.25);
    if (score > 0) scored.push({ sym, score });
  }

  // Call-graph propagation: a wrapper/entry function whose callee matched the
  // query is itself relevant (it's the surface a caller would reach), so boost
  // callers of matching symbols by a fraction of the callee's score. One pass,
  // using the raw scores computed above — no recursion, no transitive spread.
  if (scored.length) {
    const byName = new Map();
    for (const s of scored) byName.set(s.sym.name, s.score);
    for (const s of scored) {
      const calleeScore = (calleesOf(index, s.sym.name) || [])
        .reduce((acc, c) => acc + (byName.get(c.to) || 0), 0);
      if (calleeScore > 0) s.score += calleeScore * CALL_PROPAGATION;
    }
  }

  // Tie-break: equal scores → prefer the shorter function (a small, focused
  // function that mentions the query is a better hit than a giant one that
  // sweeps it up in passing).
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((a.sym.endLine - a.sym.startLine) - (b.sym.endLine - b.sym.startLine)));
  return scored.slice(0, limit).map(({ sym }) => {
    const absFile = path.join(index.root, sym.file);
    const { text, truncated } = truncateForDisplay(readLines(absFile, sym.startLine, sym.endLine), MAX_EXPLORE_SOURCE_CHARS);
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
