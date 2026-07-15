#!/usr/bin/env node
'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { loadIndex, ensureFresh } = require('./lib/index-store');
const { nodeInfo, explore } = require('./lib/query');

const server = new Server({ name: 'indexgraph', version: require('./package.json').version }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: 'indexgraph_node',
    description: "Exact symbol lookup in a project's frontend JS (functions defined inline in <script> tags inside .html files) — verbatim current source, plus who calls it and what it calls. Use when you already know the function name.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact function name to look up' },
        projectPath: { type: 'string', description: 'Absolute path to the project root (must have a .indexgraph index built via `indexgraph init`). Defaults to cwd.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'indexgraph_explore',
    description: "Keyword search over a project's frontend JS symbols (functions defined inline in <script> tags inside .html files) — ranks by name and body match, returns verbatim source + call edges for the top matches. Use for a fuzzy/natural-language question when you don't know the exact symbol name.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query' },
        projectPath: { type: 'string', description: 'Absolute path to the project root (must have a .indexgraph index built via `indexgraph init`). Defaults to cwd.' },
      },
      required: ['query'],
    },
  },
];

function formatSymbol(s) {
  const lines = [];
  lines.push(`**${s.name}** (${s.kind}) — ${s.file}:${s.startLine}`);
  lines.push('```javascript');
  lines.push(s.source);
  lines.push('```');
  if (s.callers.length) lines.push('Called by <- ' + s.callers.map(c => `${c.from} (${c.file})`).join(', '));
  if (s.callees.length) lines.push('Calls -> ' + s.callees.map(c => `${c.to} (${c.file})`).join(', '));
  return lines.join('\n');
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const root = args.projectPath || process.cwd();
  if (!loadIndex(root)) {
    return { content: [{ type: 'text', text: `No .indexgraph index found at ${root} — run "indexgraph init" in that project first.` }] };
  }
  const index = ensureFresh(root); // transparently rebuilds if any indexed file changed since last build

  if (name === 'indexgraph_node') {
    const matches = nodeInfo(index, args.name);
    if (!matches) return { content: [{ type: 'text', text: `Symbol "${args.name}" not found.` }] };
    return { content: [{ type: 'text', text: matches.map(formatSymbol).join('\n\n') }] };
  }

  if (name === 'indexgraph_explore') {
    const results = explore(index, args.query);
    if (!results.length) return { content: [{ type: 'text', text: `No matches for "${args.query}".` }] };
    return { content: [{ type: 'text', text: results.map(formatSymbol).join('\n\n') }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
server.connect(transport);
