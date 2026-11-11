'use strict';
// HTML UI layer: parse real markup with parse5 (source-location aware) instead
// of the old tag regex, which could not tell a real <style> tag from the same
// word inside a JS string. Besides extracting <script>/<style> blocks for the
// existing JS/CSS parsers (same contract as lib/extract: content + 1-indexed
// startLine), it records the UI elements themselves — tags with their id,
// class, visible static text, hint attributes and inline event bindings — as
// `uiElements`, so trace can go from something a user sees (a button label, a
// class name) to the code behind it.
const acorn = require('acorn');
const walk = require('acorn-walk');
const { parse: parseHtml } = require('parse5');

// Structural or non-visual tags: recorded nowhere (their children still are).
// <template> children live in node.content and are walked explicitly.
const SKIP_TAGS = new Set(['html', 'head', 'body', 'meta', 'link', 'base', 'script', 'style', 'title']);

// Attributes worth keeping as lookup clues beyond id/class — the things a user
// or agent can actually see or name when pointing at an element.
const HINT_ATTRS = new Set(['type', 'name', 'href', 'placeholder', 'alt', 'aria-label', 'role', 'data-testid', 'title']);

const MAX_TEXT_CHARS = 120;
const MAX_HANDLER_EXPR_CHARS = 60;

function trimText(parts) {
  const text = parts.join(' ').trim().replace(/\s+/g, ' ');
  if (text.length > MAX_TEXT_CHARS) return text.slice(0, MAX_TEXT_CHARS) + '…';
  return text;
}

// `onclick="go()"` and `@click="save"` values are inline JS expressions. Wrap
// them in a function body so bare statements (`return confirm(x)`, multiple
// statements) parse, then collect the callee names. A plain identifier call is
// a DIRECT binding; `obj.method()` contributes a candidate on the method name —
// the actual receiver is only known at runtime.
function parseInlineHandler(value) {
  if (!value || !value.trim()) return [];
  let ast;
  try {
    ast = acorn.parse(`function _ig_wrap(){\n${value}\n}`, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (_) {
    return [];
  }
  const found = [];
  walk.simple(ast, {
    CallExpression(node) {
      const c = node.callee;
      if (c.type === 'Identifier') found.push({ handler: c.name, evidence: 'direct' });
      else if (c.type === 'MemberExpression' && c.property.type === 'Identifier') {
        found.push({ handler: c.property.name, evidence: 'candidate' });
      }
    },
  });
  return found;
}

function attrMap(attrs) {
  const map = {};
  for (const a of attrs) if (!(a.name in map)) map[a.name] = a.value;
  return map;
}

// Parse one element node into a uiElement (or null for skipped tags).
function elementToUi(node) {
  const attrs = attrMap(node.attrs || []);
  const tag = node.tagName;
  const el = {
    tag,
    kind: 'element',
    startLine: node.sourceCodeLocation.startLine,
    endLine: node.sourceCodeLocation.endLine,
    col: node.sourceCodeLocation.startCol,
  };
  if (attrs.id) el.idAttr = attrs.id;
  if (attrs.class && attrs.class.trim()) el.classes = attrs.class.trim().split(/\s+/);

  const hint = {};
  for (const name of HINT_ATTRS) if (attrs[name]) hint[name] = attrs[name];
  if (Object.keys(hint).length) el.attrs = hint;

  const events = [];
  for (const [name, value] of Object.entries(attrs)) {
    const isDom = /^on[a-z]+$/.test(name);
    const isVue = name.startsWith('@') || name.startsWith('v-on:');
    if (!isDom && !isVue) continue;
    // vue-on-click → on-click style names stay verbose; keep the raw attr name
    // for both (onClick vs onclick vs @click are framework-distinct evidence).
    for (const hit of parseInlineHandler(value)) events.push({ attr: name, ...hit });
  }
  if (events.length) el.events = events;

  return el;
}

function collectDirectText(node) {
  const parts = [];
  for (const child of node.childNodes || []) {
    if (child.nodeName === '#text' && child.value && child.value.trim()) parts.push(child.value.trim());
  }
  return trimText(parts);
}

function walkNodes(node, out) {
  // Container roots (#document / template content) recurse; every other
  // non-element node (#text, #comment, #documentType) is skipped.
  if (node.nodeName === '#document' || node.nodeName === '#document-fragment') {
    for (const child of node.childNodes || []) walkNodes(child, out);
    return;
  }
  if (node.nodeName.startsWith('#')) return;
  if (node.tagName === 'template') {
    const el = elementToUi(node);
    if (!out.uiElements.some(e => e.startLine === el.startLine && e.col === el.col)) out.uiElements.push(el);
    if (node.content) walkNodes(node.content, out);
    return;
  }
  if (node.tagName === 'script') {
    // External scripts have nothing inline to parse — same rule as before.
    if ((node.attrs || []).some(a => a.name === 'src')) return;
    const text = (node.childNodes || []).find(c => c.nodeName === '#text');
    if (text && text.value.trim()) out.scriptBlocks.push({ content: text.value, startLine: text.sourceCodeLocation.startLine });
    return;
  }
  if (node.tagName === 'style') {
    const text = (node.childNodes || []).find(c => c.nodeName === '#text');
    if (text && text.value.trim()) out.styleBlocks.push({ content: text.value, startLine: text.sourceCodeLocation.startLine });
    return;
  }
  if (!SKIP_TAGS.has(node.tagName)) {
    const el = elementToUi(node);
    const text = collectDirectText(node);
    if (text) el.text = text;
    out.uiElements.push(el);
  }
  for (const child of node.childNodes || []) walkNodes(child, out);
}

// Whole-file entry point: parse the document once and return everything the
// indexer needs from an .html file. parse5's sourceCodeLocation lines are
// 1-based file lines, matching the contract parseBlock/parseCssBlock expect.
function parseHtmlDocument(html) {
  const out = { uiElements: [], scriptBlocks: [], styleBlocks: [] };
  let doc;
  try {
    doc = parseHtml(html, { sourceCodeLocationInfo: true });
  } catch (e) {
    throw new Error(`parse5 failed: ${String((e && e.message) || e)}`);
  }
  walkNodes(doc, out);
  return out;
}

module.exports = { parseHtmlDocument, parseInlineHandler };
