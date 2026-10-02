import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants, gzip, gunzip } from 'node:zlib';

const compressBr = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const decompress = { br: promisify(brotliDecompress), gzip: promisify(gunzip) };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const FONT = /^vendor\/office\/fonts\/[A-Za-z0-9_-]+$/;
const ENCODINGS = ['br', 'gzip'];
const SETTINGS = { br: { quality: 5 }, gzip: { level: 6 } };
const MANIFEST = 'font-compressed/manifest.json';
const VARIANTS = 'font-compressed/v1';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function regularFile(root, relative, label) {
  const target = path.join(root, relative);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Missing ${label}: ${relative}`);
  }
  if (!stat.isFile()) throw new Error(`Invalid ${label}: ${relative} must be a regular file`);
  return stat;
}

async function directory(root, relative) {
  const stat = await lstat(path.join(root, relative));
  if (!stat.isDirectory()) throw new Error(`Invalid artifact directory: ${relative}`);
}

async function fontEntries(root) {
  await directory(root, 'fonts');
  await regularFile(root, 'wasm-integrity-manifest.json', 'runtime manifest');
  const manifest = JSON.parse(await readFile(path.join(root, 'wasm-integrity-manifest.json'), 'utf8'));
  if (!isRecord(manifest.files)) throw new Error('Invalid original font manifest');
  const entries = Object.entries(manifest.files).filter(([name]) => name.startsWith('vendor/office/fonts/'));
  if (!entries.length) throw new Error('Original font manifest is empty');
  for (const [name, digest] of entries) {
    if (!FONT.test(name) || typeof digest !== 'string' || !HASH.test(digest)) {
      throw new Error(`Invalid original font manifest entry: ${name}`);
    }
  }
  const actual = await readdir(path.join(root, 'fonts'), { withFileTypes: true });
  for (const entry of actual) {
    if (!entry.isFile()) throw new Error(`Invalid original font directory entry: ${entry.name}`);
  }
  const actualNames = actual.map(entry => `vendor/office/fonts/${entry.name}`).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(entries.map(([name]) => name).sort())) {
    throw new Error('Original font directory coverage mismatch');
  }
  return entries.sort(([a], [b]) => a.localeCompare(b, 'en'));
}

function validateMetadata(manifest, entries) {
  if (!isRecord(manifest) || manifest.version !== 'v1' || !isRecord(manifest.fonts) ||
      manifest.compression?.br?.quality !== 5 || manifest.compression?.gzip?.level !== 6) {
    throw new Error('Invalid font compression manifest');
  }
  const expectedNames = entries.map(([name]) => name).sort();
  if (JSON.stringify(Object.keys(manifest.fonts).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error('Invalid font manifest coverage');
  }
  const variants = new Map();
  for (const [name, digest] of entries) {
    const entry = manifest.fonts[name];
    if (!isRecord(entry) || entry.sha256 !== digest) throw new Error(`Font digest mismatch: ${name}`);
    if (!isRecord(entry.variants) || JSON.stringify(Object.keys(entry.variants).sort()) !== JSON.stringify(ENCODINGS)) {
      throw new Error(`Invalid font encodings: ${name}`);
    }
    for (const encoding of ENCODINGS) {
      const variant = entry.variants[encoding];
      const expectedPath = `${VARIANTS}/${digest}.${encoding}`;
      if (!isRecord(variant) || variant.path !== expectedPath || typeof variant.sha256 !== 'string' ||
          !HASH.test(variant.sha256) || !Number.isSafeInteger(variant.size) || variant.size <= 0) {
        throw new Error(`Invalid font artifact metadata: ${name}/${encoding}`);
      }
      const previous = variants.get(expectedPath);
      if (previous && (previous.sha256 !== variant.sha256 || previous.size !== variant.size)) {
        throw new Error(`Invalid duplicate font artifact metadata: ${expectedPath}`);
      }
      variants.set(expectedPath, variant);
    }
  }
  return variants;
}

export async function verifyOfficeFonts({ assetRoot = process.cwd(), full = true } = {}) {
  const root = path.resolve(assetRoot);
  const entries = await fontEntries(root);
  await directory(root, 'font-compressed');
  await regularFile(root, MANIFEST, 'font compression manifest');
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'));
  const variants = validateMetadata(manifest, entries);
  await directory(root, VARIANTS);
  for (const name of await readdir(path.join(root, VARIANTS))) {
    if (!variants.has(`${VARIANTS}/${name}`)) throw new Error(`Unexpected font artifact: ${name}`);
  }
  const verified = new Set();
  for (const [name, digest] of entries) {
    const relative = name.slice('vendor/office/'.length);
    const originalStat = await regularFile(root, relative, 'original font');
    if (full) {
      const original = await readFile(path.join(root, relative));
      if (sha256(original) !== digest) throw new Error(`Original font integrity mismatch: ${name}`);
    }
    for (const encoding of ENCODINGS) {
      const variant = manifest.fonts[name].variants[encoding];
      if (verified.has(variant.path)) continue;
      const stat = await regularFile(root, variant.path, 'font artifact');
      if (stat.size !== variant.size) throw new Error(`Font artifact size mismatch: ${variant.path}`);
      if (full) {
        const bytes = await readFile(path.join(root, variant.path));
        if (sha256(bytes) !== variant.sha256) throw new Error(`Compressed font integrity mismatch: ${variant.path}`);
        let decoded;
        try {
          decoded = await decompress[encoding](bytes, { maxOutputLength: Math.max(1, originalStat.size) });
        } catch (error) {
          throw new Error(`Invalid compressed font: ${variant.path}`, { cause: error });
        }
        if (sha256(decoded) !== digest) throw new Error(`Decoded font integrity mismatch: ${variant.path}`);
      }
      verified.add(variant.path);
    }
  }
  return { fonts: entries.length, variants: variants.size, full };
}

async function atomicWrite(target, bytes) {
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareOfficeFonts({ assetRoot = process.cwd() } = {}) {
  const root = path.resolve(assetRoot);
  const entries = await fontEntries(root);
  // Reuse only a completely verified pack. Asset updates regenerate the pack.
  try {
    return await verifyOfficeFonts({ assetRoot: root });
  } catch {
    // Preparation repairs generated output; verification itself never repairs.
  }
  await mkdir(path.join(root, 'font-compressed'), { recursive: true });
  await directory(root, 'font-compressed');
  await mkdir(path.join(root, VARIANTS), { recursive: true });
  await directory(root, VARIANTS);
  const fonts = {};
  const generated = new Map();
  for (const [name, digest] of entries) {
    const relative = name.slice('vendor/office/'.length);
    await regularFile(root, relative, 'original font');
    const original = await readFile(path.join(root, relative));
    if (sha256(original) !== digest) throw new Error(`Original font integrity mismatch: ${name}`);
    if (!generated.has(digest)) {
      const variants = {};
      for (const encoding of ENCODINGS) {
        const bytes = encoding === 'br'
          ? await compressBr(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
          : await compressGzip(original, { level: 6 });
        const relativePath = `${VARIANTS}/${digest}.${encoding}`;
        await atomicWrite(path.join(root, relativePath), bytes);
        variants[encoding] = { path: relativePath, size: bytes.length, sha256: sha256(bytes) };
      }
      generated.set(digest, variants);
    }
    fonts[name] = { sha256: digest, variants: generated.get(digest) };
  }
  const expected = new Set([...generated.values()].flatMap(variants => ENCODINGS.map(encoding => path.basename(variants[encoding].path))));
  for (const name of await readdir(path.join(root, VARIANTS))) {
    if (!expected.has(name)) {
      const target = path.join(root, VARIANTS, name);
      if ((await lstat(target)).isDirectory()) throw new Error(`Unexpected font artifact directory: ${name}`);
      await rm(target);
    }
  }
  await atomicWrite(path.join(root, MANIFEST), `${JSON.stringify({ version: 'v1', compression: SETTINGS, fonts }, null, 2)}\n`);
  return verifyOfficeFonts({ assetRoot: root });
}

export function parseAssetRoot(argv) {
  if (!argv.length) return process.cwd();
  if (argv.length !== 2 || argv[0] !== '--asset-root' || !argv[1]) {
    throw new Error('Usage: node scripts/<prepare|verify>-office-fonts.mjs [--asset-root <dir>]');
  }
  return path.resolve(argv[1]);
}
