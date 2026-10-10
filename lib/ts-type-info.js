'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Keep hover output bounded because it is returned directly to the model.
const MAX_FIELD_CHARS = 2048;
// Bounded language-service cache: monorepos alternate between sub-package
// configs, and an unbounded map would leak one compiler per package visited.
// 4 covers the realistic "a few packages queried repeatedly" pattern.
const MAX_CACHED_SERVICES = 4;

function loadTypeScript(projectRoot) {
  try {
    const targetRequire = createRequire(path.join(projectRoot, 'package.json'));
    const targetTypeScript = targetRequire('typescript');
    if (typeof targetTypeScript.createLanguageService === 'function') return targetTypeScript;
  } catch (_) {
    // A project may not have TypeScript, or may expose a compiler without the language-service API.
  }

  const bundledTypeScript = require('typescript');
  if (typeof bundledTypeScript.createLanguageService !== 'function') {
    throw new Error('IndexGraph bundled TypeScript does not expose createLanguageService');
  }
  return bundledTypeScript;
}

function formatDiagnostics(ts, diagnostics) {
  return clip(diagnostics
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    .join('\n')) || '';
}

function loadProject(ts, projectRoot, requestedFile, configPath) {
  if (!configPath) {
    return {
      options: {
        allowJs: true,
        checkJs: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.Latest,
      },
      fileNames: [requestedFile],
    };
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(formatDiagnostics(ts, [config.error]));

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length) throw new Error(formatDiagnostics(ts, parsed.errors));

  return {
    options: parsed.options,
    // 260912 Red only seed the requested file; the language service resolves imports lazily.
    fileNames: [requestedFile],
  };
}

// Nearest-tsconfig search (IG-06): walk UP from the requested file's own
// directory to the project root (inclusive) and return the first tsconfig
// found — a monorepo's packages/app/src/x.tsx must pick up
// packages/app/tsconfig.json, not the (often absent or unrelated) root one.
// ts.findConfigFile cannot do this: it starts from one directory and only
// goes up, so we bound the walk ourselves.
function findNearestTsConfig(projectRoot, absoluteFile) {
  const rootDir = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(absoluteFile));
  for (;;) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === rootDir) return null; // reached the project root — use fallback options
    const parent = path.dirname(dir);
    if (parent === dir) return null; // file lies outside the project root; give up
    dir = parent;
  }
}

let cachedServices = new Map(); // cacheKey -> { ts, service, configVersion, state }

function fileVersion(fileName) {
  const stat = fs.statSync(fileName);
  return `${stat.mtimeMs}:${stat.size}`;
}

function disposeOldestService() {
  while (cachedServices.size >= MAX_CACHED_SERVICES) {
    const oldestKey = cachedServices.keys().next().value; // Map iterates in insertion order
    const oldest = cachedServices.get(oldestKey);
    cachedServices.delete(oldestKey);
    try { oldest.service.dispose(); } catch (_) { /* already disposed */ }
  }
}

function getLanguageService(ts, projectRoot, requestedFile) {
  const configPath = findNearestTsConfig(projectRoot, requestedFile);
  // One cache slot per config (or per fallback project) — NOT a process-wide
  // singleton, which thrashed when queries alternated between packages.
  const cacheKey = configPath || `__fallback__:${path.resolve(projectRoot)}`;
  const configVersion = configPath ? fileVersion(configPath) : null;

  let cached = cachedServices.get(cacheKey);
  if (cached) {
    // Refresh LRU order + invalidate on config edit or a different TS copy.
    if (cached.ts !== ts || cached.configVersion !== configVersion) {
      cachedServices.delete(cacheKey);
      try { cached.service.dispose(); } catch (_) { /* already disposed */ }
      cached = null;
    } else {
      cachedServices.delete(cacheKey);
      cachedServices.set(cacheKey, cached);
    }
  }
  if (!cached) {
    disposeOldestService();
    const project = loadProject(ts, projectRoot, requestedFile, configPath);
    const state = {
      options: project.options,
      requestedFile: project.fileNames[0],
    };
    const service = ts.createLanguageService({
      getCompilationSettings: () => state.options,
      getCurrentDirectory: () => projectRoot,
      getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
      getScriptFileNames: () => [state.requestedFile],
      getScriptSnapshot: fileName => {
        const text = ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getScriptVersion: fileVersion,
      fileExists: ts.sys.fileExists,
      readDirectory: ts.sys.readDirectory,
      readFile: ts.sys.readFile,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    });
    cached = { ts, service, configVersion, state };
    cachedServices.set(cacheKey, cached);
  }

  cached.state.requestedFile = requestedFile;
  return cached;
}

function lineColumnToOffset(source, line, column) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }

  if (line < 1 || line > lineStarts.length) {
    throw new Error(`Line ${line} is outside ${lineStarts.length} available lines`);
  }

  const lineStart = lineStarts[line - 1];
  const newline = source.indexOf('\n', lineStart);
  const rawEnd = newline === -1 ? source.length : newline;
  const lineEnd = source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
  const lineLength = lineEnd - lineStart;
  if (column < 1 || column > lineLength + 1) {
    throw new Error(`Column ${column} is outside line ${line} (1-${lineLength + 1})`);
  }

  return lineStart + column - 1;
}

function clip(value) {
  if (!value) return null;
  if (value.length <= MAX_FIELD_CHARS) return value;
  const suffix = '\n... (truncated)';
  return `${value.slice(0, MAX_FIELD_CHARS - suffix.length)}${suffix}`;
}

function getTypeInfo({ projectPath, file, line, column }) {
  const projectRoot = path.resolve(projectPath || process.cwd());
  const absoluteFile = path.isAbsolute(file) ? path.resolve(file) : path.resolve(projectRoot, file);
  const source = fs.readFileSync(absoluteFile, 'utf8');
  const ts = loadTypeScript(projectRoot);
  // 260912 Red create lazily, then reuse one service per project to avoid compiler cold starts.
  const { service } = getLanguageService(ts, projectRoot, absoluteFile);
  const info = service.getQuickInfoAtPosition(
    absoluteFile,
    lineColumnToOffset(source, line, column)
  );

  return {
    file: clip(path.relative(projectRoot, absoluteFile) || path.basename(absoluteFile)),
    line,
    column,
    kind: info?.kind ?? null,
    type: clip(info ? ts.displayPartsToString(info.displayParts) : null),
    documentation: clip(info ? ts.displayPartsToString(info.documentation) : null),
  };
}

module.exports = { getTypeInfo, findNearestTsConfig };
