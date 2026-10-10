#!/usr/bin/env node
'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { loadIndex, ensureFresh, indexFileState } = require('./lib/index-store');
const { nodeInfo, explore } = require('./lib/query');
const { getTypeInfo } = require('./lib/ts-type-info');

const MAX_ERROR_CHARS = 2048;
const server = new Server({ name: 'indexgraph', version: require('./package.json').version }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: 'indexgraph_node',
    description: "Exact symbol lookup in a project's frontend code embedded in .html files (inline <script>/<style>) or in standalone .css files — a JS function or a CSS rule (looked up by its full selector or by any bare class/id name it contains) — verbatim current source, plus (for JS) who calls it and what it calls. Use when you already know the function name, selector, or class/id.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact function name, full CSS selector, or bare class/id name (no leading . or # required) to look up' },
        projectPath: { type: 'string', description: 'Absolute path to the project root (must have a .indexgraph index built via `indexgraph init`). Defaults to cwd.' },
        depth: { type: 'number', minimum: 1, maximum: 3, default: 1, description: 'How many hops of callers/callees to collect. 1 = direct callers/callees only. 2-3 adds indirect (transitive) relationships, flattened with a level field.' },
        file: { type: 'string', description: 'Optional: restrict matches to this file (relative to project root, or absolute) — disambiguates same-name symbols.' },
        maxResults: { type: 'number', minimum: 1, description: 'Optional: cap how many same-name matches to return.' },
        mode: { type: 'string', enum: ['detail', 'summary'], default: 'detail', description: 'detail = full symbol source (default); summary = short source prefix plus location and call edges, for disambiguating many same-name matches cheaply.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'indexgraph_explore',
    description: "Keyword search over a project's frontend code embedded in .html files (inline <script>/<style>) and in standalone .css files — JS functions and CSS rules — ranks by name and body match (name hits > body hits, longer functions normalized), returns source prefix + call edges for the top matches. Use for a fuzzy/natural-language question when you don't know the exact symbol name or selector.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query' },
        projectPath: { type: 'string', description: 'Absolute path to the project root (must have a .indexgraph index built via `indexgraph init`). Defaults to cwd.' },
        limit: { type: 'number', minimum: 1, maximum: 10, default: 5, description: 'Max number of top matches to return.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'indexgraph_type_info',
    description: "TypeScript/JavaScript semantic hover lookup — returns the inferred type and documentation at an exact file position, like VS Code. Use for generic, union, overload, and API-signature questions; this does not require an .indexgraph index.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'TypeScript or JavaScript file, relative to projectPath or absolute' },
        line: { type: 'number', minimum: 1, description: '1-based line number' },
        column: { type: 'number', minimum: 1, description: '1-based column number' },
        projectPath: { type: 'string', description: 'Absolute project root containing tsconfig.json; defaults to cwd' },
      },
      required: ['file', 'line', 'column'],
    },
  },
];

// depth>1 node lookups tag each edge with how many hops out it sits; render
// that as a short prefix so the flattened list stays readable:
//   Called by (1) <- A, B
//   Called by (2) <- C, D
function formatEdgeList(edges) {
  const byLevel = new Map();
  for (const e of edges) {
    const lvl = e.level || 1; // depth=1 edges ({file, from}) carry no level field
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    // Unresolved candidates (cross-file calls parseBlock couldn't bind to one
    // specific symbol) get a trailing `?` — never read as a certain edge.
    const label = e.unresolved ? `${e.to}?` : (e.name || e.from || e.to);
    byLevel.get(lvl).push(label);
  }
  const parts = [];
  for (const [lvl, names] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    parts.push(`(${lvl}) ${names.join(', ')}`);
  }
  return parts.join('; ');
}

function formatSymbol(s) {
  const lines = [];
  const viaGraph = s.matchReason === 'graph' ? ' ~via call graph' : '';
  lines.push(`**${s.name}** (${s.kind}) — ${s.file}:${s.startLine}${viaGraph}`);
  lines.push('```' + (s.kind.startsWith('css') ? 'css' : 'javascript'));
  lines.push(s.source);
  lines.push('```');
  if (s.callers.length) lines.push('Called by <- ' + formatEdgeList(s.callers));
  if (s.callees.length) lines.push('Calls -> ' + formatEdgeList(s.callees));
  return lines.join('\n');
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const root = args.projectPath || process.cwd();
  if (name === 'indexgraph_type_info') {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(getTypeInfo(args)) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const suffix = '\n... (truncated)';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: message.length <= MAX_ERROR_CHARS
              ? message
              : `${message.slice(0, MAX_ERROR_CHARS - suffix.length)}${suffix}`,
          }),
        }],
      };
    }
  }

  // Only a genuinely MISSING index file asks for init; an existing but
  // corrupt/incompatible one goes through ensureFresh and self-heals
  // (IG08-F01 — the old loadIndex() pre-check turned corrupt into "not found").
  if (indexFileState(root) === 'missing') {
    return { content: [{ type: 'text', text: `No .indexgraph index found at ${root} — run "indexgraph init" in that project first.` }] };
  }
  const index = ensureFresh(root); // transparently rebuilds if any indexed file changed since last build

  if (name === 'indexgraph_node') {
    const result = nodeInfo(index, args.name, args.depth || 1, {
      file: args.file,
      maxResults: args.maxResults,
      mode: args.mode,
    });
    if (!result) return { content: [{ type: 'text', text: `Symbol "${args.name}" not found.` }] };
    const { matches, omitted } = result;
    let text = matches.map(formatSymbol).join('\n\n');
    if (omitted.length) {
      text += `\n\n${omitted.length} more same-name match(es) omitted (response budget) — ` +
        omitted.map(o => `${o.file}:${o.startLine}`).join(', ') +
        `. Re-query with file/maxResults to fetch them.`;
    }
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'indexgraph_explore') {
    const results = explore(index, args.query, args.limit || 5);
    if (!results.length) return { content: [{ type: 'text', text: `No matches for "${args.query}".` }] };
    return { content: [{ type: 'text', text: results.map(formatSymbol).join('\n\n') }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
server.connect(transport);
