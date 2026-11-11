'use strict';
// Vue SFC parsing with @vue/compiler-sfc. One .vue file contributes:
//   symbols/edges  — from <script setup> and <script>, via the shared TS
//                    module parser (ScriptKind follows the lang= attribute),
//                    line numbers shifted from block-relative to file lines
//   uiElements     — from the template AST: tags with their static text,
//                    class/id/hint attributes and event directives
//                    (@click="save" / v-on:submit.prevent / plain onclick)
//   styleBlocks    — each <style> block for the existing CSS rule parser
// Vue files have no single component symbol; the SFC itself is the component,
// so elements carry componentName (from the file name) without a componentId.
// All line/col numbers are 1-based file positions; a template/expression the
// compiler cannot handle degrades to a recorded parseError, never silence.
const { parse: parseSfc } = require('@vue/compiler-sfc');
const { baseParse } = require('@vue/compiler-dom');
const ts = require('typescript');
const { parseTsModule } = require('./parse-ui-tsx');
const { parseInlineHandler } = require('./parse-ui-html');
const { buildLineStarts, lineAt } = require('./parse');
const path = require('path');

const MAX_TEXT_CHARS = 120;
const MAX_EXPR_CHARS = 60;

// NodeTypes of @vue/compiler-core (stable numeric enum): 1 element, 2 text,
// 5 interpolation, 6 attribute, 7 directive. tagType 1 = component reference.
const NODE_ELEMENT = 1, NODE_TEXT = 2, NODE_ATTRIBUTE = 6, NODE_DIRECTIVE = 7;
const TAG_COMPONENT = 1;

const HINT_ATTRS = new Set(['type', 'name', 'href', 'placeholder', 'alt', 'aria-label', 'role', 'data-testid', 'title']);

// Absolute file offset of a descriptor block's content (blocks wrap their
// tags in loc.source; content starts after the open tag).
function blockContentStart(block) {
  const idx = block.loc.source.indexOf(block.content);
  return block.loc.start.offset + (idx >= 0 ? idx : 0);
}

function truncExpr(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > MAX_EXPR_CHARS ? t.slice(0, MAX_EXPR_CHARS) + '…' : t;
}

// Vue template expressions: `@click="save"` (bare identifier → direct),
// `@click="save()"` / `@click="if(x) save()"` (parse the statements).
function directiveHandlerExpr(expr) {
  const text = String(expr || '').trim();
  if (!text) return [];
  if (/^[A-Za-z_$][\w$]*$/.test(text)) return [{ handler: text, evidence: 'direct' }];
  return parseInlineHandler(text);
}

function buildUiFromTemplate(templateAst, errors, relLineToFile, out) {
  (function walk(node) {
    if (node.type === NODE_ELEMENT) {
      const fileLine = relLineToFile(node.loc.start.line);
      const el = {
        tag: node.tag,
        kind: node.tagType === TAG_COMPONENT ? 'component-use' : 'element',
        startLine: fileLine,
        endLine: relLineToFile(node.loc.end.line),
        col: node.loc.start.column,
        componentName: out.componentName,
      };
      const classes = [];
      const attrs = {};
      const events = [];
      let candidateClass = null;
      for (const prop of node.props || []) {
        if (prop.type === NODE_ATTRIBUTE) {
          const value = prop.value ? prop.value.content : '';
          if (prop.name === 'class' && value.trim()) classes.push(...value.trim().split(/\s+/));
          else if (prop.name === 'id') el.idAttr = value;
          else if (HINT_ATTRS.has(prop.name) && value) attrs[prop.name] = value;
          else if (/^on[a-z]+$/.test(prop.name)) {
            for (const hit of parseInlineHandler(value)) events.push({ attr: prop.name, ...hit });
          }
        } else if (prop.type === NODE_DIRECTIVE) {
          const arg = prop.arg && prop.arg.content;
          if (prop.name === 'on' && arg) {
            for (const hit of directiveHandlerExpr(prop.exp && prop.exp.content)) {
              events.push({ attr: `@${arg}`, ...hit });
            }
          } else if (prop.name === 'bind' && arg === 'class' && prop.exp && prop.exp.content) {
            candidateClass = truncExpr(prop.exp.content);
          }
        }
      }
      if (classes.length) el.classes = classes;
      if (candidateClass) el.candidateClass = candidateClass;
      if (events.length) el.events = events;
      if (Object.keys(attrs).length) el.attrs = attrs;
      const textParts = [];
      (function collectText(n) {
        for (const c of n.children || []) {
          if (c.type === NODE_TEXT && c.content.trim()) textParts.push(c.content.trim());
          else if (c.type === NODE_ELEMENT) continue; // only direct text
        }
      })(node);
      if (textParts.length) {
        const joined = textParts.join(' ').replace(/\s+/g, ' ').trim();
        el.text = joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) + '…' : joined;
      }
      out.uiElements.push(el);
    }
    for (const c of node.children || []) walk(c);
  })(templateAst);
}

function parseVueSfc(source, componentName) {
  const out = { symbols: [], edges: [], uiElements: [], styleBlocks: [], componentName };
  const errors = [];
  const { descriptor, errors: sfcErrors } = parseSfc(source, { filename: `${componentName || 'component'}.vue` });
  if (sfcErrors && sfcErrors.length) {
    // Non-fatal errors still leave usable blocks; record them like block errors.
    for (const e of sfcErrors) errors.push(`sfc: ${String((e && e.message) || e)}`);
  }

  const lineStarts = buildLineStarts(source);
  const lineOfFileOffset = offset => lineAt(lineStarts, offset, 1);

  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (!block || !block.content.trim()) continue;
    const kind = block.lang === 'ts' || block.lang === 'tsx' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    try {
      const parsed = parseTsModule(block.content, kind);
      const contentStartLine = lineOfFileOffset(blockContentStart(block));
      for (const s of parsed.symbols) {
        s.startLine += contentStartLine - 1;
        s.endLine += contentStartLine - 1;
        out.symbols.push(s);
      }
      out.edges.push(...parsed.edges);
    } catch (e) {
      errors.push(`script@${block.loc.start.line}: ${String((e && e.message) || e)}`);
    }
  }

  if (descriptor.template && descriptor.template.content.trim()) {
    try {
      // baseParse, not compileTemplate: the full compiler rewrites event
      // expressions (`@click="save"` becomes a _ctx-guarded call), which
      // would corrupt the handler evidence. baseParse keeps raw sources.
      // Template errors are collected, not fatal — partial markup stays useful.
      const templateErrors = [];
      const templateAst = baseParse(descriptor.template.content, { onError: err => templateErrors.push(err) });
      for (const e of templateErrors) errors.push(`template: ${String((e && e.message) || e)}`);
      const contentStartLine = lineOfFileOffset(blockContentStart(descriptor.template));
      buildUiFromTemplate(templateAst, errors, relLine => contentStartLine + relLine - 1, out);
    } catch (e) {
      errors.push(`template@${descriptor.template.loc.start.line}: ${String((e && e.message) || e)}`);
    }
  }

  for (const style of descriptor.styles || []) {
    if (style.content.trim()) {
      out.styleBlocks.push({ content: style.content, startLine: lineOfFileOffset(blockContentStart(style)) });
    }
  }

  if (errors.length) out.parseErrors = errors;
  return out;
}

module.exports = { parseVueSfc };
