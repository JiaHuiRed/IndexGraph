'use strict';
// Shared fixture helpers for the IndexGraph test suite — each test builds a
// throwaway project in a unique temp dir instead of relying on any real
// project (CHANGELOG 0.0.5 notes the same fixtures should not depend on
// personal projects like dossier/SystemManager).
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeProject(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-test-'));
  // after hooks run FIFO: this rm may fire before the mcp-stdio test's child
  // kill hook, and Windows denies deleting a directory a live process still
  // holds. Swallow that — retries absorb the short EPERM window, and worst
  // case the OS temp cleanup takes the leftover.
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (_) { /* child still holding the dir */ }
  });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

module.exports = { makeProject };
