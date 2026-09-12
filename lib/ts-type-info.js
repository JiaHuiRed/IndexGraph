'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Keep hover output bounded because it is returned directly to the model.
const MAX_FIELD_CHARS = 2048;

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

let cachedService;

function fileVersion(fileName) {
  const stat = fs.statSync(fileName);
  return `${stat.mtimeMs}:${stat.size}`;
}

function getLanguageService(ts, projectRoot, requestedFile) {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json');
  const configVersion = configPath ? fileVersion(configPath) : null;
  if (
    !cachedService ||
    cachedService.ts !== ts ||
    cachedService.projectRoot !== projectRoot ||
    cachedService.configPath !== configPath ||
    cachedService.configVersion !== configVersion
  ) {
    cachedService?.service.dispose();
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
    cachedService = { configPath, configVersion, projectRoot, service, state, ts };
  }

  cachedService.state.requestedFile = requestedFile;
  return cachedService;
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

module.exports = { getTypeInfo };
