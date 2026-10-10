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
// indexgraph_node 一次响应的源码总预算：几十个同名符号各带全量源码能把 MCP
// 输出顶爆（IG-05）。装满后余下的匹配降级为一行定位信息，agent 仍能用
// file/maxResults 收窄后拿到目标——截断但不失联。
const NODE_TOTAL_BUDGET_CHARS = 24000;
// summary 模式下每符号只带这一点源码（形状 + 定位，不是全文）
const SUMMARY_SOURCE_CHARS = 300;
// depth>1 时每个方向的边列表上限，超出的截断并标记
const EDGE_LIST_LIMIT = 60;

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

// Callers/callees are looked up per SYMBOL ID, not per name (IG-01): same-name
// functions in different files (or shadowed in one file) each carry only the
// edges that genuinely point at them.
function callersOf(index, symbolId) {
  const out = [];
  for (const [file, data] of Object.entries(index.files)) {
    for (const e of data.edges) if (e.toId === symbolId) out.push({ file, from: e.from, fromId: e.fromId });
  }
  return out;
}

function calleesOf(index, symbolId) {
  const out = [];
  for (const [file, data] of Object.entries(index.files)) {
    for (const e of data.edges) {
      if (e.fromId === symbolId) {
        out.push({ file, to: e.to, toId: e.toId, unresolved: !!e.unresolved });
      }
    }
  }
  return out;
}

// Collect callers/callees to `depth` levels. Level 1 = direct edges.
// Deeper levels are the direct edges of each symbol found at the previous
// level, flattened and deduped — the result stays a flat list (with the
// `level` field marking how many hops out each symbol sits), never nested,
// so the MCP text output stays readable.
function collectEdges(index, symbolId, direction, depth) {
  const out = [];
  const seen = new Set();
  let frontier = [symbolId];
  for (let level = 1; level <= depth; level++) {
    const next = [];
    for (const id of frontier) {
      const edges = direction === 'callers' ? callersOf(index, id) : calleesOf(index, id);
      for (const e of edges) {
        const otherId = direction === 'callers' ? e.fromId : e.toId;
        if (otherId === symbolId) continue; // self-loops aren't informative
        const key = otherId + '@' + level;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name: direction === 'callers' ? e.from : e.to, id: otherId, file: e.file, level });
        }
        next.push(otherId);
      }
    }
    frontier = next;
  }
  return out;
}

function capEdges(edges) {
  if (edges.length <= EDGE_LIST_LIMIT) return { edges, truncated: false };
  return { edges: edges.slice(0, EDGE_LIST_LIMIT), truncated: true };
}

// Exact lookup with a bounded response (IG-05):
//   opts.file        — only matches from this file (relative path or absolute)
//   opts.maxResults  — cap on how many same-name matches to return
//   opts.mode        — 'detail' (default, full source up to per-symbol cap)
//                      or 'summary' (short source prefix, header + edges only)
//   opts.maxChars    — total source budget across all matches (default
//                      NODE_TOTAL_BUDGET_CHARS)
// Returns { matches, omitted }: matches carry source (possibly truncated),
// omitted lists the matches that didn't fit the budget — each still carries
// name/file/startLine so the caller can re-query with a narrower filter.
function nodeInfo(index, name, depth = 1, opts = {}) {
  let matches = findSymbol(index, name);
  if (!matches.length) return null;
  if (opts.file) {
    const want = path.resolve(opts.file);
    matches = matches.filter(m => m.file === opts.file || path.resolve(path.join(index.root, m.file)) === want);
    if (!matches.length) return null;
  }
  if (opts.maxResults > 0) matches = matches.slice(0, opts.maxResults);

  const perCap = opts.mode === 'summary' ? SUMMARY_SOURCE_CHARS : MAX_SOURCE_CHARS;
  let budget = typeof opts.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : NODE_TOTAL_BUDGET_CHARS;
  const omitted = [];
  const out = matches.map(sym => {
    const absFile = path.join(index.root, sym.file);
    const { edges: callers, truncated: callersTruncated } = capEdges(
      depth > 1 ? collectEdges(index, sym.id, 'callers', depth) : callersOf(index, sym.id));
    const { edges: callees, truncated: calleesTruncated } = capEdges(
      depth > 1 ? collectEdges(index, sym.id, 'callees', depth) : calleesOf(index, sym.id));
    const base = {
      ...sym,
      absFile,
      callers: callers.filter(c => c.from !== sym.name),
      callees,
      callersTruncated,
      calleesTruncated,
    };
    let full;
    try { full = readLines(absFile, sym.startLine, sym.endLine); } catch (_) { full = ''; }
    const { text, truncated } = truncateForDisplay(full, perCap);
    if (text.length <= budget) {
      budget -= text.length;
      return { ...base, source: text, truncated };
    }
    if (budget > 200) {
      const slice = text.slice(0, budget - 80) + `\n... (source budget exhausted — re-query with file:"${sym.file}" for the full symbol)`;
      budget = 0;
      return { ...base, source: slice, truncated: true };
    }
    omitted.push({ name: sym.name, file: sym.file, startLine: sym.startLine });
    return null;
  }).filter(Boolean);

  return { matches: out, omitted };
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
    let nameHit = false;
    for (const w of words) {
      if (nameLower === w) { score += NAME_EXACT; nameHit = true; }
      else if (nameLower.includes(w)) { score += NAME_PARTIAL; nameHit = true; }
    }
    // Body text always contributes (previously this only ran when the name
    // matched nothing at all, so a symbol whose NAME partially matched could
    // never accrue the richer body-text signal and lost to unrelated symbols
    // whose bodies happened to contain more of the query's words).
    const body = bodyTextOf(sym);
    let wordHits = 0;
    for (const w of words) {
      const n = Math.min(countHits(body, w), MAX_WORD_HITS);
      if (n) wordHits += n;
    }
    let uniqBigrams = 0;
    for (const bg of bigrams) if (body.includes(bg)) uniqBigrams++;
    // Relevance floor — a lone one-off body mention is noise, not a match.
    // Querying about CSS `backdrop-filter` while the only hit anywhere is a
    // local variable named `filterWrap` used to return that symbol as a top
    // "match", which misleads an agent far more than an honest "no matches"
    // would. Keep a symbol only if its name matched, or the body corroborated
    // the query with at least two hits (two different words, repeated mentions
    // of one word, or two distinct CJK bigrams).
    if (!nameHit && wordHits + uniqBigrams < 2) continue;
    let bodyScore = wordHits * BODY_WORD + Math.min(uniqBigrams, MAX_UNIQUE_BIGRAMS) * BODY_BIGRAM;
    if (BUILDER_NAME.test(sym.name)) bodyScore *= BUILDER_BODY_DAMP;
    score += bodyScore / Math.pow(1 + body.length / 4000, 0.25);
    if (score > 0) scored.push({ sym, score, matchReason: 'direct' });
  }

  // Call-graph propagation, two directions (IG-04):
  //   1. within the direct hits — a wrapper whose callee matched gains a
  //      fraction of the callee's score (unchanged from 0.0.6, but now on
  //      per-symbol edges so same-name symbols don't cross-contaminate);
  //   2. rescuing callers the floor filtered out — a caller of a strong
  //      direct hit enters the pool with matchReason 'graph'. It can't pretend
  //      to be a text match; the 0.2 fraction and the direct/graph tag keep
  //      it below genuine hits while letting agents see the real entry point.
  // One pass each, no recursion, no transitive spread.
  if (scored.length) {
    const byId = new Map(scored.map(s => [s.sym.id, s.score]));
    for (const s of scored) {
      const calleeScore = calleesOf(index, s.sym.id)
        .reduce((acc, c) => acc + (byId.get(c.toId) || 0), 0);
      if (calleeScore > 0) s.score += calleeScore * CALL_PROPAGATION;
    }
    const directIds = new Set(byId.keys());
    const graphBoost = new Map(); // callerId -> accumulated callee score
    for (const data of Object.values(index.files)) {
      for (const e of data.edges) {
        if (directIds.has(e.toId) && !directIds.has(e.fromId)) {
          graphBoost.set(e.fromId, (graphBoost.get(e.fromId) || 0) + byId.get(e.toId));
        }
      }
    }
    const symbolById = new Map();
    for (const sym of allSymbols(index)) symbolById.set(sym.id, sym);
    for (const [callerId, boost] of graphBoost) {
      const sym = symbolById.get(callerId);
      if (sym && boost > 0) scored.push({ sym, score: boost * CALL_PROPAGATION, matchReason: 'graph' });
    }
  }

  // Tie-break: equal scores → prefer the shorter function (a small, focused
  // function that mentions the query is a better hit than a giant one that
  // sweeps it up in passing).
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((a.sym.endLine - a.sym.startLine) - (b.sym.endLine - b.sym.startLine)));
  return scored.slice(0, limit).map(({ sym, matchReason, score }) => {
    const absFile = path.join(index.root, sym.file);
    const { text, truncated } = truncateForDisplay(readLines(absFile, sym.startLine, sym.endLine), MAX_EXPLORE_SOURCE_CHARS);
    const { edges: callers, truncated: callersTruncated } = capEdges(callersOf(index, sym.id));
    const { edges: callees, truncated: calleesTruncated } = capEdges(calleesOf(index, sym.id));
    return {
      ...sym,
      absFile,
      source: text,
      truncated,
      score,
      matchReason,
      callers: callers.filter(c => c.from !== sym.name),
      callees,
      callersTruncated,
      calleesTruncated,
    };
  });
}

module.exports = { findSymbol, callersOf, calleesOf, nodeInfo, explore, allSymbols, NODE_TOTAL_BUDGET_CHARS };
