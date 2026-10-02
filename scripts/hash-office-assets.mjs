import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_VERSION = "v1";
const MANIFEST_FILE_NAME = "wasm-integrity-manifest.json";
const MANIFEST_PATH_PREFIX = "vendor/office";
const RUNTIME_DIRECTORIES = ["fonts", "sdkjs", "web-apps"];
const RUNTIME_ROOT_FILES = ["document_editor_service_worker.js", "plugins.json", "themes.json"];
const RUNTIME_EXCLUDED_PATH_SEGMENTS = ["/help/", "/examples/", "/docs/"];
const RUNTIME_HASHED_EXTENSIONS = new Set([".js", ".css", ".wasm", ".json", ".bin"]);

function printUsage() {
  console.log(
    [
      "Usage: node scripts/hash-office-assets.mjs [--asset-root <dir>]",
      "",
      "Examples:",
      "  node scripts/hash-office-assets.mjs",
      "  node scripts/hash-office-assets.mjs --asset-root /path/to/office-runtime-assets",
      "",
      "Asset root defaults to current working directory.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  let assetRoot;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, assetRoot: undefined };
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
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { help: false, assetRoot };
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function resolveAssetRoot(input) {
  const candidate = input?.trim();
  return path.resolve(candidate || process.cwd());
}

function toManifestRelativePath(assetRelativePath) {
  return `${MANIFEST_PATH_PREFIX}/${toPosixPath(assetRelativePath)}`;
}

function shouldHashRuntimeAsset(assetRelativePath) {
  const normalizedPath = toPosixPath(assetRelativePath);

  if (RUNTIME_ROOT_FILES.includes(normalizedPath)) {
    return true;
  }

  // Font payloads use extensionless numeric names and must travel with AllFonts.js.
  if (normalizedPath.startsWith("fonts/")) {
    return true;
  }

  if (normalizedPath.endsWith(`/${MANIFEST_FILE_NAME}`) || normalizedPath.endsWith(".map")) {
    return false;
  }

  if (RUNTIME_EXCLUDED_PATH_SEGMENTS.some(segment => normalizedPath.includes(segment))) {
    return false;
  }

  const extension = path.posix.extname(normalizedPath).toLowerCase();
  return RUNTIME_HASHED_EXTENSIONS.has(extension);
}

async function isFile(absolutePath) {
  const stat = await fs.stat(absolutePath).catch(() => null);
  return Boolean(stat?.isFile());
}

async function isDirectory(absolutePath) {
  const stat = await fs.stat(absolutePath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function collectDirectoryFiles(assetRoot, relativeDirectory) {
  const directoryPath = path.join(assetRoot, relativeDirectory);
  if (!(await isDirectory(directoryPath))) {
    return [];
  }

  const results = [];

  async function walk(currentDirectory) {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      const relativePath = path.relative(assetRoot, absolutePath);
      if (shouldHashRuntimeAsset(relativePath)) {
        results.push(toManifestRelativePath(relativePath));
      }
    }
  }

  await walk(directoryPath);
  return results;
}

async function collectRootFiles(assetRoot) {
  const results = [];
  for (const fileName of RUNTIME_ROOT_FILES) {
    const absolutePath = path.join(assetRoot, fileName);
    if (await isFile(absolutePath) && shouldHashRuntimeAsset(fileName)) {
      results.push(toManifestRelativePath(fileName));
    }
  }
  return results;
}

async function collectManifestFiles(assetRoot) {
  const collected = [];

  for (const directoryName of RUNTIME_DIRECTORIES) {
    const files = await collectDirectoryFiles(assetRoot, directoryName);
    collected.push(...files);
  }

  const rootFiles = await collectRootFiles(assetRoot);
  collected.push(...rootFiles);

  const uniqueSorted = [...new Set(collected)]
    .filter(relativePath => relativePath !== `${MANIFEST_PATH_PREFIX}/${MANIFEST_FILE_NAME}`)
    .sort((left, right) => left.localeCompare(right));

  if (uniqueSorted.length === 0) {
    throw new Error("No core runtime assets found to hash under sdkjs/, web-apps/, or root runtime files.");
  }

  return uniqueSorted;
}

async function hashFile(assetRoot, manifestPath) {
  const runtimeRelativePath = manifestPath.replace(`${MANIFEST_PATH_PREFIX}/`, "");
  const absolutePath = path.join(assetRoot, runtimeRelativePath);
  const content = await fs.readFile(absolutePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export async function hashOfficeAssets({ assetRootArg } = {}) {
  const assetRoot = resolveAssetRoot(assetRootArg);
  const exists = await isDirectory(assetRoot);
  if (!exists) {
    throw new Error(`Asset root does not exist: ${assetRoot}`);
  }

  const files = await collectManifestFiles(assetRoot);
  const manifestFiles = {};
  for (const manifestPath of files) {
    manifestFiles[manifestPath] = await hashFile(assetRoot, manifestPath);
  }

  const payload = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    files: manifestFiles,
  };

  const manifestAbsolutePath = path.join(assetRoot, MANIFEST_FILE_NAME);
  await fs.writeFile(manifestAbsolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    manifestAbsolutePath,
    fileCount: files.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const result = await hashOfficeAssets({ assetRootArg: args.assetRoot });
  console.log(`Wrote ${result.fileCount} runtime hashes to ${result.manifestAbsolutePath}`);
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntrypoint) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
