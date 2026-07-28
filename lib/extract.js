'use strict';
const fs = require('fs');

// Shared block extractor for `<tagName ...>...</tagName>` — used for both
// <script> and <style>. Computes the open-tag length arithmetically from the
// full match (m[0].length - content.length - closeTagLength) instead of
// re-searching for `content` inside `m[0]`, so it's exact regardless of the
// tag name's length or how many attributes it carries.
function extractTagBlocks(html, tagName, opts) {
  opts = opts || {};
  const blocks = [];
  const re = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (opts.skipIfSrc && /\bsrc\s*=/.test(attrs)) continue; // external file, nothing to parse
    const content = m[2];
    const closeTagLen = tagName.length + 3; // "</" + tagName + ">"
    const openTagLen = m[0].length - content.length - closeTagLen;
    const contentStart = m.index + openTagLen;
    // Count newlines before the content to get its starting line (1-indexed)
    const before = html.slice(0, contentStart);
    const startLine = (before.match(/\n/g) || []).length + 1;
    blocks.push({ content, startLine });
  }
  return blocks;
}

// Pull out inline <script> blocks (no src=) from an HTML file, each with the
// 1-indexed line number where its content begins, so AST line numbers can be
// mapped back to real positions in the original file.
function extractScripts(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  return extractTagBlocks(html, 'script', { skipIfSrc: true });
}

// Pull out inline <style> blocks from an HTML file, same line-mapping
// contract as extractScripts.
function extractStyles(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf-8');
  return extractTagBlocks(html, 'style', {});
}

module.exports = { extractScripts, extractStyles };
