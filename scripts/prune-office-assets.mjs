import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ALLOWED_LOCALES = ['en', 'zh'];
const DEFAULT_ALLOWED_HELP_LOCALES = ['en'];
const DEFAULT_ALLOWED_MONACO_LOCALES = ['en', 'zh-cn'];
const HELP_DIR_ALWAYS_KEEP = new Set(['images', 'search']);
const HELP_LANG_PATTERN = /^[a-z]{2}(?:-[a-z]{2})?$/i;

function normalizeLocale(value) {
  return value.trim().toLowerCase();
}

function normalizeLocaleSet(values, fallback) {
  const base = values && values.length > 0 ? values : fallback;
  return new Set(base.map(normalizeLocale).filter(Boolean));
}

function localeFromFilename(filename) {
  const extension = path.extname(filename);
  if (!extension) return '';
  return normalizeLocale(filename.slice(0, -extension.length));
}

async function directoryExists(directoryPath) {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function summarizeDirectory(directoryPath) {
  const summary = { files: 0, directories: 0, bytes: 0 };
  const stack = [directoryPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        summary.directories += 1;
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      summary.files += 1;
      const stat = await fs.stat(absolutePath);
      summary.bytes += stat.size;
    }
  }

  return summary;
}

async function removeFile(filePath, result, dryRun) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return;
  result.removedFiles += 1;
  result.removedBytes += stat.size;
  if (!dryRun) {
    await fs.rm(filePath, { force: true });
  }
}

async function removeDirectory(directoryPath, result, dryRun) {
  const summary = await summarizeDirectory(directoryPath);
  result.removedDirectories += summary.directories + 1;
  result.removedFiles += summary.files;
  result.removedBytes += summary.bytes;
  if (!dryRun) {
    await fs.rm(directoryPath, { recursive: true, force: true });
  }
}

function shouldRemoveHelpDirectory(name, allowedHelpLocales) {
  const normalized = normalizeLocale(name);
  if (HELP_DIR_ALWAYS_KEEP.has(normalized)) return false;
  if (!HELP_LANG_PATTERN.test(normalized)) return false;
  return !allowedHelpLocales.has(normalized);
}

async function pruneLocaleFiles(assetRoot, allowedLocales, result, dryRun) {
  const appsRoot = path.join(assetRoot, 'web-apps', 'apps');
  if (!(await directoryExists(appsRoot))) return;

  const appEntries = await fs.readdir(appsRoot, { withFileTypes: true });
  for (const appEntry of appEntries) {
    if (!appEntry.isDirectory()) continue;
    const appRoot = path.join(appsRoot, appEntry.name);
    const stack = [appRoot];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) continue;
      const currentEntries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const currentEntry of currentEntries) {
        const absolutePath = path.join(currentDir, currentEntry.name);
        if (!currentEntry.isDirectory()) continue;

        if (currentEntry.name === 'locale') {
          const localeEntries = await fs.readdir(absolutePath, { withFileTypes: true });
          for (const localeEntry of localeEntries) {
            if (!localeEntry.isFile()) continue;
            if (!localeEntry.name.endsWith('.json') && !localeEntry.name.endsWith('.js')) {
              continue;
            }
            result.scannedLocaleFiles += 1;
            const locale = localeFromFilename(localeEntry.name);
            if (!locale || allowedLocales.has(locale)) continue;
            await removeFile(path.join(absolutePath, localeEntry.name), result, dryRun);
          }
          continue;
        }

        stack.push(absolutePath);
      }
    }
  }
}

async function pruneHelpDirectories(assetRoot, allowedHelpLocales, result, dryRun) {
  const appsRoot = path.join(assetRoot, 'web-apps', 'apps');
  if (!(await directoryExists(appsRoot))) return;

  const appEntries = await fs.readdir(appsRoot, { withFileTypes: true });
  for (const appEntry of appEntries) {
    if (!appEntry.isDirectory()) continue;
    const helpRoot = path.join(appsRoot, appEntry.name, 'main', 'resources', 'help');
    if (!(await directoryExists(helpRoot))) continue;

    const helpEntries = await fs.readdir(helpRoot, { withFileTypes: true });
    for (const helpEntry of helpEntries) {
      if (!helpEntry.isDirectory()) continue;
      result.scannedHelpDirectories += 1;
      if (!shouldRemoveHelpDirectory(helpEntry.name, allowedHelpLocales)) {
        continue;
      }
      await removeDirectory(path.join(helpRoot, helpEntry.name), result, dryRun);
    }
  }
}

async function pruneMonacoNlsFiles(assetRoot, allowedMonacoLocales, result, dryRun) {
  const monacoVsDir = path.join(assetRoot, 'web-apps', 'vendor', 'monaco', 'monaco', 'min', 'vs');
  if (!(await directoryExists(monacoVsDir))) return;

  const entries = await fs.readdir(monacoVsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith('nls.messages.') || !entry.name.endsWith('.js')) continue;
    result.scannedMonacoNlsFiles += 1;
    const locale = normalizeLocale(entry.name.replace(/^nls\.messages\./, '').replace(/\.js$/, ''));
    if (!locale || allowedMonacoLocales.has(locale)) continue;
    await removeFile(path.join(monacoVsDir, entry.name), result, dryRun);
  }
}

export async function pruneOfficeAssets(assetRoot = process.cwd(), options = {}) {
  const root = path.resolve(assetRoot);
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`OFFICE asset root does not exist: ${root}`);
  }

  const allowedLocales = normalizeLocaleSet(options.locales, DEFAULT_ALLOWED_LOCALES);
  const allowedHelpLocales = normalizeLocaleSet(
    options.helpLocales,
    DEFAULT_ALLOWED_HELP_LOCALES,
  );
  const allowedMonacoLocales = normalizeLocaleSet(
    options.monacoLocales,
    DEFAULT_ALLOWED_MONACO_LOCALES,
  );
  const dryRun = Boolean(options.dryRun);

  const result = {
    scannedLocaleFiles: 0,
    scannedHelpDirectories: 0,
    scannedMonacoNlsFiles: 0,
    removedFiles: 0,
    removedDirectories: 0,
    removedBytes: 0,
  };

  await pruneLocaleFiles(root, allowedLocales, result, dryRun);
  await pruneHelpDirectories(root, allowedHelpLocales, result, dryRun);
  await pruneMonacoNlsFiles(root, allowedMonacoLocales, result, dryRun);

  return result;
}

function parseListArg(value, fallback) {
  if (!value) return fallback;
  const parts = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

function parseCliArguments(argv) {
  let assetRoot = process.cwd();
  let locales = DEFAULT_ALLOWED_LOCALES;
  let helpLocales = DEFAULT_ALLOWED_HELP_LOCALES;
  let monacoLocales = DEFAULT_ALLOWED_MONACO_LOCALES;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--asset-root') {
      assetRoot = argv[index + 1] ? path.resolve(argv[index + 1]) : assetRoot;
      index += 1;
      continue;
    }
    if (current === '--locales') {
      locales = parseListArg(argv[index + 1], DEFAULT_ALLOWED_LOCALES);
      index += 1;
      continue;
    }
    if (current === '--help-locales') {
      helpLocales = parseListArg(argv[index + 1], DEFAULT_ALLOWED_HELP_LOCALES);
      index += 1;
      continue;
    }
    if (current === '--monaco-locales') {
      monacoLocales = parseListArg(argv[index + 1], DEFAULT_ALLOWED_MONACO_LOCALES);
      index += 1;
      continue;
    }
    if (current === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (current === '--json') {
      json = true;
    }
  }

  return {
    assetRoot,
    locales,
    helpLocales,
    monacoLocales,
    dryRun,
    json,
  };
}

async function runCli() {
  const args = parseCliArguments(process.argv.slice(2));
  const result = await pruneOfficeAssets(args.assetRoot, {
    locales: args.locales,
    helpLocales: args.helpLocales,
    monacoLocales: args.monacoLocales,
    dryRun: args.dryRun,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `OFFICE prune completed (dryRun=${String(args.dryRun)}): removedFiles=${result.removedFiles}, removedDirectories=${result.removedDirectories}, removedBytes=${result.removedBytes}`,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  runCli().catch(error => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
