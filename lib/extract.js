'use strict';
const fs = require('fs');

// Pull out inline <script> blocks (no src=) from an HTML file, each with the
// 1-indexed line number where its content begins, so AST line numbers can be
// mapped back to real positions in the original file.
function extractScripts(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const blocks = [];
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue; // external script, nothing to parse
    const content = m[2];
    const contentStart = m.index + m[0].indexOf(content, m[1] ? m[1].length + 8 : 8);
    // Count newlines before the content to get its starting line (1-indexed)
    const before = html.slice(0, contentStart);
    const startLine = (before.match(/\n/g) || []).length + 1;
    blocks.push({ content, startLine });
  }
  return blocks;
}

module.exports = { extractScripts };
