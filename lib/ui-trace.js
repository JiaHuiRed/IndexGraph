'use strict';
// UI trace: from something a user sees — a button label, a CSS class, a DOM
// id, a component name — to the code most likely behind it. Queries the
// per-file uiElements recorded at index time and assembles the relationships
// around each hit, every edge labeled with its evidence level:
//   [direct]    statically resolvable reference (onClick={handleSave},
//               @click="save", onclick="save()")
//   [candidate] real but not statically resolvable (inline arrow, dynamic
//               class expression, obj.method() receiver unknown)
//   [selector]  CSS rule whose selector names this class/id — a match
//               candidate, never a claim about the runtime cascade
// No invented edges: a handler the index never saw is reported as not bound,
// never guessed by name similarity.
const path = require('path');
const { calleesOf, buildDerived } = require('./query');

const MAX_CALLS_PER_HANDLER = 20;
const MAX_STYLES_PER_ELEMENT = 8;
const MAX_COMPONENT_DEFS = 5;

// ── Derived lookup tables, cached per index-object identity ───────────────
// Cross-file UI ↔ CSS / UI ↔ component relationships are NOT persisted into
// file entries (a stale edge would survive a component's class rename); they
// are rebuilt here from the current index. The WeakMap keys on the immutable
// index object, same contract as lib/query's derivedCache.
const traceCache = new WeakMap();

function buildTraceDerived(index) {
  const hit = traceCache.get(index);
  if (hit) return hit;
  const byClass = new Map(); // class token -> [{ file, absFile, el }]
  const byId = new Map();    // id attribute  -> [{ file, absFile, el }]
  const byComponent = new Map(); // componentName -> [{ file, absFile, el }]
  const all = [];
  for (const [file, data] of Object.entries(index.files)) {
    const absFile = path.join(index.root, file);
    for (const el of data.uiElements || []) {
      const wrapped = { file, absFile, el };
      all.push(wrapped);
      const add = (map, key) => {
        if (!key) return;
        let bucket = map.get(key);
        if (!bucket) { bucket = []; map.set(key, bucket); }
        bucket.push(wrapped);
      };
      for (const c of el.classes || []) add(byClass, c);
      add(byId, el.idAttr);
      add(byComponent, el.componentName);
    }
  }
  const d = { index, all, byClass, byId, byComponent };
  traceCache.set(index, d);
  return d;
}

// `.save#main` / `div.save-btn` / `button` — tag plus .class/#id constraints.
function parseSelector(selector) {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(String(selector || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  const constraints = { tag: m[1] || null, classes: [], id: null };
  const re = /([.#])([\w-]+)/g;
  let hit;
  while ((hit = re.exec(m[2]))) {
    if (hit[1] === '.') constraints.classes.push(hit[2]);
    else constraints.id = hit[2];
  }
  return constraints;
}

// CSS-selector semantics for the `selector` clue: every constraint must hold
// (tag, id, all listed classes) — this is a hard filter, unlike the score-
// based single-clue matches.
function elementMatches(el, constraints) {
  if (constraints.tag && el.tag.toLowerCase() !== constraints.tag.toLowerCase()) return false;
  if (constraints.id && el.idAttr !== constraints.id) return false;
  for (const c of constraints.classes) if (!(el.classes || []).includes(c)) return false;
  return true;
}

// Score a candidate against the clues it matched. Only matches of at least
// one clue enter the result — a component whose body merely mentions the
// query text is not a UI match (that remains explore()'s job).
function scoreElement(el, clues, textLower) {
  let score = 0;
  if (clues.text && el.text) {
    const t = el.text.toLowerCase();
    if (t === textLower) score += 4;
    else if (t.includes(textLower)) score += 2;
  }
  if (clues.className && (el.classes || []).includes(clues.className)) score += 3;
  if (clues.id && el.idAttr === clues.id) score += 3;
  if (clues.component && el.componentName === clues.component) score += 3;
  if (clues.tag && el.tag.toLowerCase() === clues.tag.toLowerCase()) score += 2;
  return score;
}

// Bind an event handler name to index symbols. Same-file binding wins; other
// same-name symbols are listed as ambiguity, never silently picked.
function bindHandler(index, d, wrapped, handler) {
  const symbols = [...(d.byName.get(handler) || [])];
  const sameFile = symbols.filter(s => s.file === wrapped.file);
  const others = symbols.filter(s => s.file !== wrapped.file);
  if (sameFile.length === 1) {
    const sym = sameFile[0];
    return { symbol: sym, ambiguity: [], crossFile: others };
  }
  if (sameFile.length > 1) {
    return { symbol: null, ambiguity: sameFile, crossFile: others };
  }
  if (others.length) return { symbol: null, ambiguity: [], crossFile: others };
  return { symbol: null, ambiguity: [], crossFile: [] };
}

function callsOf(index, d, symbolId, depth) {
  const out = [];
  let truncated = false;
  const room = () => {
    if (out.length >= MAX_CALLS_PER_HANDLER) { truncated = true; return false; }
    return true;
  };
  // Level 1 also surfaces unresolved cross-file candidates, name only — they
  // cannot be descended into, but hiding them would overstate certainty.
  const resolvedIds = [];
  for (const e of calleesOf(index, symbolId)) {
    if (!room()) break;
    const sym = e.toId ? d.byId.get(e.toId) : null;
    if (e.unresolved || !sym) out.push({ name: e.to, file: e.file, unresolved: true, level: 1 });
    else {
      out.push({ name: e.to, file: e.file, startLine: sym.startLine, kind: sym.kind, level: 1 });
      resolvedIds.push(e.toId);
    }
  }
  // Deeper levels descend through resolved edges only, but unresolved
  // candidates still surface at their level (name + ?, never descended into).
  const seen = new Set(resolvedIds);
  let frontier = resolvedIds;
  for (let level = 2; level <= depth && frontier.length && !truncated; level++) {
    const next = [];
    for (const id of frontier) {
      for (const e of calleesOf(index, id)) {
        if (e.unresolved || !e.toId) {
          const key = `u:${e.to}`;
          if (!seen.has(key)) {
            seen.add(key);
            if (!room()) break;
            out.push({ name: e.to, file: e.file, unresolved: true, level });
          }
          continue;
        }
        if (seen.has(e.toId)) continue;
        seen.add(e.toId);
        const sym = d.byId.get(e.toId);
        if (!room()) break;
        out.push({ name: e.to, file: e.file, startLine: sym ? sym.startLine : undefined, kind: sym ? sym.kind : undefined, level });
        next.push(e.toId);
      }
      if (truncated) break;
    }
    frontier = next;
  }
  return { calls: out, truncated };
}

function styleCandidatesFor(index, d, el) {
  const keys = new Set(el.classes || []);
  if (el.idAttr) keys.add(el.idAttr);
  const out = [];
  let truncated = false;
  for (const key of keys) {
    for (const sym of d.byName.get(key) || []) {
      if (!sym.kind.startsWith('css')) continue;
      if (out.length >= MAX_STYLES_PER_ELEMENT) { truncated = true; break; }
      out.push({ name: sym.name, file: sym.file, startLine: sym.startLine, kind: sym.kind });
    }
  }
  return { rules: out, truncated };
}

// Where a component-use tag is defined — capitalized tags reference components.
function componentDefsFor(index, d, el) {
  if (el.kind !== 'component-use') return { defs: [], truncated: false };
  const defs = [];
  for (const sym of d.byName.get(el.tag) || []) {
    if (sym.kind !== 'component' && sym.kind !== 'function' && sym.kind !== 'arrow' && sym.kind !== 'class') continue;
    if (defs.length >= MAX_COMPONENT_DEFS) return { defs, truncated: true };
    defs.push({ name: sym.name, file: sym.file, startLine: sym.startLine, kind: sym.kind });
  }
  return { defs, truncated: false };
}

// Main entry. `clues` needs at least one of: text, className, id, component,
// selector, tag. `opts.file` is a hard filter (relative or absolute).
// Returns { matches, omitted, clues } — matches carry locations and evidence-
// labeled relationships but no source bodies (a trace stays small; source
// belongs to indexgraph_node / Read).
function trace(index, clues, opts) {
  clues = clues || {};
  opts = opts || {};
  const d = buildTraceDerived(index);
  const queryDerived = buildDerived(index);

  const constraints = clues.selector ? parseSelector(clues.selector) : null;
  if (clues.selector && !constraints) return { error: `cannot parse selector: ${clues.selector}` };

  const active = [];
  const textLower = clues.text ? String(clues.text).toLowerCase() : null;
  if (clues.text) active.push('text');
  if (clues.className) active.push('className');
  if (clues.id) active.push('id');
  if (clues.component) active.push('component');
  if (clues.tag) active.push('tag');
  if (constraints) active.push('selector');
  if (!active.length) return { error: 'provide at least one clue: text, className, id, component, selector or tag' };

  // Candidate pool: clue-directed map lookups where possible; the text clue
  // has a contains-semantics that needs a linear sweep (UI element counts are
  // small — hundreds — so the sweep is cheap and cached bodies stay unused).
  let pool;
  if (clues.className && d.byClass.has(clues.className)) pool = d.byClass.get(clues.className);
  else if (clues.id && d.byId.has(clues.id)) pool = d.byId.get(clues.id);
  else if (clues.component && d.byComponent.has(clues.component)) pool = d.byComponent.get(clues.component);
  else pool = d.all;

  let fileFilter = null;
  if (opts.file) fileFilter = path.resolve(index.root, opts.file);

  const scored = [];
  const selectorOnly = constraints && active.length === 1;
  for (const wrapped of pool) {
    if (fileFilter && path.resolve(wrapped.absFile) !== fileFilter) continue;
    // A selector clue is a hard CSS-semantics filter. As the only clue it
    // matches every element satisfying it; combined with other clues it only
    // boosts elements the other clues already hit — a text+selector query is
    // "the matching element, constrained to this selector", not "every
    // element of this tag".
    if (constraints && !elementMatches(wrapped.el, constraints)) continue;
    let score = scoreElement(wrapped.el, clues, textLower);
    if (constraints) score = selectorOnly ? 2 : (score > 0 ? score + 2 : 0);
    if (score > 0) scored.push({ wrapped, score });
  }
  // Equal scores: earlier document position first — stable, and the top of a
  // file is usually the container, not a nested repeat.
  scored.sort((a, b) => b.score - a.score ||
    (a.wrapped.file + ':' + a.wrapped.el.startLine).localeCompare(b.wrapped.file + ':' + b.wrapped.el.startLine, undefined, { numeric: true }));

  const limit = opts.limit > 0 ? opts.limit : 5;
  const depth = opts.depth > 0 ? Math.min(opts.depth, 3) : 1;

  const matches = [];
  const omitted = [];
  for (const { wrapped } of scored) {
    if (matches.length >= limit) { omitted.push({ file: wrapped.file, startLine: wrapped.el.startLine, tag: wrapped.el.tag }); continue; }
    const el = wrapped.el;
    const compSym = el.componentId ? queryDerived.byId.get(el.componentId) : null;

    const events = [];
    for (const ev of el.events || []) {
      const bound = bindHandler(index, queryDerived, wrapped, ev.handler);
      const entry = { attr: ev.attr, handler: ev.handler, evidence: ev.evidence };
      if (ev.dynamic) entry.dynamic = true;
      if (bound.symbol) {
        entry.symbol = { name: bound.symbol.name, file: bound.symbol.file, startLine: bound.symbol.startLine, kind: bound.symbol.kind };
        const { calls, truncated } = callsOf(index, queryDerived, bound.symbol.id, depth);
        entry.calls = calls;
        entry.callsTruncated = truncated;
      } else if (bound.ambiguity.length) {
        entry.ambiguous = bound.ambiguity.map(s => ({ file: s.file, startLine: s.startLine }));
      } else if (bound.crossFile.length) {
        entry.crossFileCandidates = bound.crossFile.slice(0, MAX_COMPONENT_DEFS)
          .map(s => ({ file: s.file, startLine: s.startLine, kind: s.kind }));
      } else {
        entry.notIndexed = true; // handler not a project symbol (DOM API, external)
      }
      events.push(entry);
    }

    const styles = styleCandidatesFor(index, queryDerived, el);
    const defs = componentDefsFor(index, queryDerived, el);

    matches.push({
      file: wrapped.file,
      absFile: wrapped.absFile,
      id: el.id,
      tag: el.tag,
      kind: el.kind,
      startLine: el.startLine,
      endLine: el.endLine,
      col: el.col,
      text: el.text,
      classes: el.classes,
      candidateClass: el.candidateClass,
      idAttr: el.idAttr,
      attrs: el.attrs,
      component: compSym ? { name: compSym.name, file: compSym.file, startLine: compSym.startLine, kind: compSym.kind } : (el.componentName ? { name: el.componentName, file: wrapped.file, startLine: undefined, kind: 'component' } : null),
      events,
      styleCandidates: styles.rules,
      styleCandidatesTruncated: styles.truncated,
      componentUses: defs.defs,
      componentUsesTruncated: defs.truncated,
    });
  }
  return { matches, omitted, clues, clueList: active };
}

// Shared text rendering for MCP and CLI. Evidence labels stay on every edge
// so an agent can tell confirmed bindings from static guesses at a glance.
function formatTrace(result) {
  if (result.error) return `Trace error: ${result.error}`;
  if (!result.matches.length) return 'No UI elements match the given clues.';
  const parts = [];
  for (const m of result.matches) {
    const label = m.idAttr ? `${m.tag}#${m.idAttr}` : m.tag;
    parts.push(`UI: ${label}${m.text ? ` "${m.text}"` : ''}  (${m.file}:${m.startLine})`);
    if (m.component) {
      parts.push(`  Component: ${m.component.name}${m.component.startLine ? ` (${m.component.file}:${m.component.startLine})` : ' (location not indexed)'}`);
    }
    for (const ev of m.events) {
      if (ev.symbol) {
        const tag = ev.evidence === 'direct' ? 'direct binding' : 'candidate';
        parts.push(`  Event: ${ev.attr} -> ${ev.handler} [${tag}] — ${ev.symbol.file}:${ev.symbol.startLine}${ev.dynamic ? ' (dynamic expression)' : ''}`);
        if (ev.calls && ev.calls.length) {
          parts.push(`    Calls -> ${ev.calls.map(c => `${c.unresolved ? c.name + '?' : c.name}${c.level > 1 ? ` (${c.level})` : ''}`).join(', ')}${ev.callsTruncated ? ' …(+more)' : ''}`);
        }
      } else if (ev.ambiguous && ev.ambiguous.length) {
        parts.push(`  Event: ${ev.attr} -> ${ev.handler} [ambiguous] same-name symbols at ${ev.ambiguous.map(a => `${a.file}:${a.startLine}`).join(', ')}`);
      } else if (ev.crossFileCandidates && ev.crossFileCandidates.length) {
        parts.push(`  Event: ${ev.attr} -> ${ev.handler} [candidate] found in other files: ${ev.crossFileCandidates.map(a => `${a.file}:${a.startLine}`).join(', ')}`);
      } else {
        parts.push(`  Event: ${ev.attr} -> ${ev.handler} [not indexed — external or DOM API]`);
      }
    }
    if (m.classes && m.classes.length) parts.push(`  Classes: ${m.classes.join(' ')} [static]`);
    if (m.candidateClass) parts.push(`  Dynamic class: ${m.candidateClass} [candidate — computed at runtime]`);
    if (m.attrs && Object.keys(m.attrs).length) {
      parts.push(`  Attrs: ${Object.entries(m.attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}`);
    }
    if (m.styleCandidates && m.styleCandidates.length) {
      parts.push('  Style candidates:');
      for (const r of m.styleCandidates) parts.push(`    ${r.file}:${r.startLine} ${r.name} [selector match]`);
      if (m.styleCandidatesTruncated) parts.push('    …(+more)');
    }
    if (m.componentUses && m.componentUses.length) {
      parts.push(`  Component refs: ${m.componentUses.map(c => `${c.name} (${c.file}:${c.startLine})`).join(', ')}${m.componentUsesTruncated ? ' …(+more)' : ''}`);
    }
  }
  if (result.omitted.length) {
    parts.push(`\n+${result.omitted.length} more match(es) omitted — re-query with a narrower clue or file: ${result.omitted.map(o => `${o.file}:${o.startLine}`).join(', ')}`);
  }
  parts.push('\nCaveat: [candidate]/[selector match]/[ambiguous] are static evidence only — the runtime CSS cascade, dynamic handlers and actual execution are NOT verified.');
  return parts.join('\n');
}

module.exports = { trace, formatTrace, parseSelector };
