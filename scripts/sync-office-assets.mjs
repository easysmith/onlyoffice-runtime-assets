import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_CACHE_SUFFIX, repairChineseFonts } from "./repair-chinese-fonts.mjs";
import { readYaHeiPayloads, YAHEI_PACK_PATH } from "./yahei-font-pack.mjs";

const DEFAULT_SOURCE_ROOT = process.env.OFFICE_WASM_VENDOR_SOURCE_DIR?.trim() ?? "";
const REQUIRED_SOURCE_DIRS = ["web-apps", "sdkjs", "fonts"];
const DOCS_API_SCRIPT_RELATIVE_PATH = path.join("web-apps", "apps", "api", "documents", "api.js");
const SERVICE_WORKER_SOURCE_RELATIVE_PATH = path.join(
  "sdkjs",
  "common",
  "serviceworker",
  "document_editor_service_worker.js",
);
const SERVICE_WORKER_TARGET_NAME = "document_editor_service_worker.js";
const SERVICE_WORKER_CACHE_SUFFIX = FONT_CACHE_SUFFIX;
const SOCKET_IO_SCRIPT_RELATIVE_PATH = path.join(
  "web-apps",
  "vendor",
  "socketio",
  "socket.io.min.js",
);
const ROOT_PLUGINS_CONFIG_NAME = "plugins.json";
const ROOT_THEMES_CONFIG_NAME = "themes.json";
const DEFAULT_ROOT_PLUGINS_CONFIG = {
  pluginsData: [],
};
const DEFAULT_ROOT_THEMES_CONFIG = {
  themes: [
    { id: "theme-white", name: "White", type: "light" },
    { id: "theme-night", name: "Night", type: "dark" },
    { id: "theme-classic-light", name: "Classic Light", type: "light" },
    { id: "theme-dark", name: "Dark", type: "dark" },
  ],
};

function printUsage() {
  console.log(
    [
      "Usage: node scripts/sync-office-assets.mjs [--asset-root <dir>] [--source-root <dir>|<dir>]",
      "",
      "Examples:",
      "  node scripts/sync-office-assets.mjs --source-root /path/to/upstream/vendor",
      "  node scripts/sync-office-assets.mjs /path/to/upstream/vendor --asset-root .",
      "",
      "Source root can also come from OFFICE_WASM_VENDOR_SOURCE_DIR.",
      "Asset root defaults to current working directory.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let sourceRoot;
  let assetRoot;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { help: true, sourceRoot: undefined, assetRoot: undefined };
    }
    if (arg === "--source-root") {
      index += 1;
      sourceRoot = argv[index];
      if (!sourceRoot) {
        throw new Error("Missing value for --source-root");
      }
      continue;
    }
    if (arg === "--asset-root") {
      index += 1;
      assetRoot = argv[index];
      if (!assetRoot) {
        throw new Error("Missing value for --asset-root");
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!sourceRoot) {
      sourceRoot = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { help: false, sourceRoot, assetRoot };
}

function resolveSourceRoot(cliSourceArg) {
  const cliSource = cliSourceArg?.trim();
  const sourceRoot = cliSource || DEFAULT_SOURCE_ROOT;
  if (!sourceRoot) {
    throw new Error(
      "Missing source directory. Pass --source-root (or positional arg), or set OFFICE_WASM_VENDOR_SOURCE_DIR",
    );
  }
  return path.resolve(sourceRoot);
}

function resolveAssetRoot(assetRootArg) {
  const candidate = assetRootArg?.trim();
  return path.resolve(candidate || process.cwd());
}

async function ensureDirectoryExists(directory) {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Directory does not exist: ${directory}`);
  }
}

export async function copyRequiredDirectories(sourceRoot, assetRoot) {
  // A fresh --asset-root has no local pack yet; seed it from this checkout.
  const hasPack = await fs.stat(path.join(assetRoot, YAHEI_PACK_PATH)).then(() => true).catch(error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const packRoot = hasPack ? assetRoot : fileURLToPath(new URL("../", import.meta.url));
  const yahei = await readYaHeiPayloads(packRoot);
  if (!hasPack) {
    await fs.mkdir(path.join(assetRoot, path.dirname(YAHEI_PACK_PATH)), { recursive: true });
    await fs.copyFile(path.join(packRoot, YAHEI_PACK_PATH), path.join(assetRoot, YAHEI_PACK_PATH));
  }
  for (const directoryName of REQUIRED_SOURCE_DIRS) {
    const sourceDirectory = path.join(sourceRoot, directoryName);
    const targetDirectory = path.join(assetRoot, directoryName);

    await ensureDirectoryExists(sourceDirectory);
    await fs.rm(targetDirectory, { recursive: true, force: true });
    await fs.cp(sourceDirectory, targetDirectory, { recursive: true });
    if (directoryName === "fonts") {
      for (const { file, data } of yahei) await fs.writeFile(path.join(targetDirectory, file), data);
    }
  }
}

async function patchDocsApiVersionInjection(assetRoot) {
  const docsApiScriptPath = path.join(assetRoot, DOCS_API_SCRIPT_RELATIVE_PATH);
  const scriptContent = await fs.readFile(docsApiScriptPath, "utf8");

  const patchedContent = scriptContent.replace(/const ver = '\/[^']+';/, "const ver = '';");
  if (patchedContent === scriptContent) {
    throw new Error(`Failed to patch DocsAPI version path injection: ${docsApiScriptPath}`);
  }

  await fs.writeFile(docsApiScriptPath, patchedContent, "utf8");
}

async function exposeDocumentServiceWorker(assetRoot) {
  const sourcePath = path.join(assetRoot, SERVICE_WORKER_SOURCE_RELATIVE_PATH);
  const targetPath = path.join(assetRoot, SERVICE_WORKER_TARGET_NAME);

  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`Missing service worker source file: ${sourcePath}`);
  }

  await fs.copyFile(sourcePath, targetPath);

  const serviceWorkerContent = await fs.readFile(targetPath, "utf8");
  const withCacheSuffix = serviceWorkerContent.replace(
    "var g_cacheName=g_cacheNamePrefix+g_version;",
    `var g_cacheName=g_cacheNamePrefix+g_version+"${SERVICE_WORKER_CACHE_SUFFIX}";`,
  );
  const patchedServiceWorkerContent = withCacheSuffix.replace(
    "if(responseFromNetwork.status===200)event.waitUntil(putInCache(request,responseFromNetwork.clone()));",
    "if(responseFromNetwork.status===200&&!responseFromNetwork.redirected&&responseFromNetwork.url===request.url)event.waitUntil(putInCache(request,responseFromNetwork.clone()));",
  );

  if (patchedServiceWorkerContent !== serviceWorkerContent) {
    await fs.writeFile(targetPath, patchedServiceWorkerContent, "utf8");
  }
}

async function stripDanglingSocketIoSourceMap(assetRoot) {
  const socketIoScriptPath = path.join(assetRoot, SOCKET_IO_SCRIPT_RELATIVE_PATH);
  const scriptContent = await fs.readFile(socketIoScriptPath, "utf8");
  const sourceMapRef = scriptContent.match(/\n\/\/# sourceMappingURL=([^\s]+)\s*$/);
  if (!sourceMapRef) {
    return;
  }

  const sourceMapPath = path.resolve(path.dirname(socketIoScriptPath), sourceMapRef[1]);
  const sourceMapExists = await fs
    .stat(sourceMapPath)
    .then(stat => stat.isFile())
    .catch(() => false);
  if (sourceMapExists) {
    return;
  }

  const patchedContent = scriptContent.replace(/\n\/\/# sourceMappingURL=[^\n]+\s*$/, "\n");
  await fs.writeFile(socketIoScriptPath, patchedContent, "utf8");
}

async function ensureRootEditorConfigFiles(assetRoot) {
  const pluginsPath = path.join(assetRoot, ROOT_PLUGINS_CONFIG_NAME);
  const themesPath = path.join(assetRoot, ROOT_THEMES_CONFIG_NAME);

  const pluginsExists = await fs
    .stat(pluginsPath)
    .then(stat => stat.isFile())
    .catch(() => false);
  if (!pluginsExists) {
    await fs.writeFile(pluginsPath, `${JSON.stringify(DEFAULT_ROOT_PLUGINS_CONFIG, null, 2)}\n`, "utf8");
  }

  const themesExists = await fs
    .stat(themesPath)
    .then(stat => stat.isFile())
    .catch(() => false);
  if (!themesExists) {
    await fs.writeFile(themesPath, `${JSON.stringify(DEFAULT_ROOT_THEMES_CONFIG, null, 2)}\n`, "utf8");
  }
}

export async function syncOfficeAssets({ sourceRootArg, assetRootArg } = {}) {
  const sourceRoot = resolveSourceRoot(sourceRootArg);
  const assetRoot = resolveAssetRoot(assetRootArg);

  await ensureDirectoryExists(assetRoot);
  await copyRequiredDirectories(sourceRoot, assetRoot);
  await patchDocsApiVersionInjection(assetRoot);
  await exposeDocumentServiceWorker(assetRoot);
  await stripDanglingSocketIoSourceMap(assetRoot);
  await ensureRootEditorConfigFiles(assetRoot);
  await repairChineseFonts(assetRoot);

  console.log(`Synced OFFICE assets from ${sourceRoot} to ${assetRoot}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  await syncOfficeAssets({ sourceRootArg: args.sourceRoot, assetRootArg: args.assetRoot });
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
