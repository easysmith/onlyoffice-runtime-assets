import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareOfficeFonts, verifyOfficeFonts } from '../scripts/office-font-artifacts.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = Buffer.from('Chinese font fixture 字体\n'.repeat(100));

async function fixture(t, duplicate = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'office-font-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'fonts'));
  await writeFile(path.join(root, 'fonts/000'), original);
  const files = { 'vendor/office/fonts/000': hash(original) };
  if (duplicate) {
    await writeFile(path.join(root, 'fonts/001'), original);
    files['vendor/office/fonts/001'] = hash(original);
  }
  await writeFile(path.join(root, 'wasm-integrity-manifest.json'), JSON.stringify({ version: 'v1', files }));
  return root;
}

test('generates both encodings, deduplicates digests and is deterministic', async t => {
  const root = await fixture(t, true);
  const first = await prepareOfficeFonts({ assetRoot: root });
  assert.equal(first.fonts, 2);
  assert.equal(first.variants, 2);
  const manifest = await readFile(path.join(root, 'font-compressed/manifest.json'));
  assert.equal((await verifyOfficeFonts({ assetRoot: root })).fonts, 2);
  await prepareOfficeFonts({ assetRoot: root });
  assert.deepEqual(await readFile(path.join(root, 'font-compressed/manifest.json')), manifest);
});

test('rejects original font integrity mismatches before generation', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'fonts/000'), 'changed');
  await assert.rejects(prepareOfficeFonts({ assetRoot: root }), /integrity mismatch/);
});

test('full verification rejects corrupt bytes even if metadata hashes are updated', async t => {
  const root = await fixture(t);
  await prepareOfficeFonts({ assetRoot: root });
  const manifestPath = path.join(root, 'font-compressed/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  const variant = manifest.fonts['vendor/office/fonts/000'].variants.br;
  const broken = Buffer.from('corrupt brotli');
  await writeFile(path.join(root, variant.path), broken);
  variant.size = broken.length;
  variant.sha256 = hash(broken);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await verifyOfficeFonts({ assetRoot: root, full: false });
  await assert.rejects(verifyOfficeFonts({ assetRoot: root }), /Invalid compressed font/);
});

test('verification rejects missing and stale variants without repairing them', async t => {
  const root = await fixture(t);
  await prepareOfficeFonts({ assetRoot: root });
  const target = path.join(root, `font-compressed/v1/${hash(original)}.br`);
  await rm(target);
  await assert.rejects(verifyOfficeFonts({ assetRoot: root, full: false }), /Missing font artifact/);
  await prepareOfficeFonts({ assetRoot: root });
  await writeFile(path.join(root, 'font-compressed/v1/stale.br'), 'stale');
  await assert.rejects(verifyOfficeFonts({ assetRoot: root }), /Unexpected font artifact/);
});

test('regeneration removes obsolete generated variants after a font update', async t => {
  const root = await fixture(t);
  await prepareOfficeFonts({ assetRoot: root });
  const changed = Buffer.from('new revision');
  await writeFile(path.join(root, 'fonts/000'), changed);
  await writeFile(path.join(root, 'wasm-integrity-manifest.json'), JSON.stringify({
    version: 'v1', files: { 'vendor/office/fonts/000': hash(changed) },
  }));
  await assert.rejects(verifyOfficeFonts({ assetRoot: root, full: false }), /digest mismatch/);
  await prepareOfficeFonts({ assetRoot: root });
  await verifyOfficeFonts({ assetRoot: root });
  await assert.rejects(readFile(path.join(root, `font-compressed/v1/${hash(original)}.br`)), /ENOENT/);
});

test('rejects path traversal, malformed hashes and unsupported encodings', async t => {
  const root = await fixture(t);
  await prepareOfficeFonts({ assetRoot: root });
  const target = path.join(root, 'font-compressed/manifest.json');
  const valid = JSON.parse(await readFile(target));
  for (const mutate of [
    value => { value.fonts['vendor/office/fonts/000'].variants.br.path = '../outside'; },
    value => { value.fonts['vendor/office/fonts/000'].variants.br.sha256 = 'bad'; },
    value => { value.fonts['vendor/office/fonts/000'].variants.deflate = {}; },
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    await writeFile(target, JSON.stringify(value));
    await assert.rejects(verifyOfficeFonts({ assetRoot: root, full: false }), /Invalid/);
  }
});

test('CI verifies committed font digests before regenerating the original manifest', async () => {
  const workflow = await readFile(new URL('../.github/workflows/runtime-assets-guard.yml', import.meta.url), 'utf8');
  const verify = workflow.indexOf('node scripts/verify-office-fonts.mjs --asset-root .');
  const hash = workflow.indexOf('node scripts/hash-office-assets.mjs --asset-root .');
  assert.ok(verify >= 0 && hash > verify);
});

test('rejects a new font omitted from both manifests before verification or preparation', async t => {
  const root = await fixture(t);
  await prepareOfficeFonts({ assetRoot: root });
  await writeFile(path.join(root, 'fonts/001'), original);
  for (const full of [true, false]) {
    await assert.rejects(verifyOfficeFonts({ assetRoot: root, full }), /Original font directory coverage mismatch/);
  }
  await assert.rejects(prepareOfficeFonts({ assetRoot: root }), /Original font directory coverage mismatch/);
});

test('rejects a missing original font and unexpected nested font directory', async t => {
  const root = await fixture(t);
  await prepareOfficeFonts({ assetRoot: root });
  await rm(path.join(root, 'fonts/000'));
  await assert.rejects(verifyOfficeFonts({ assetRoot: root }), /Original font directory coverage mismatch/);
  await writeFile(path.join(root, 'fonts/000'), original);
  await mkdir(path.join(root, 'fonts/nested'));
  await assert.rejects(verifyOfficeFonts({ assetRoot: root }), /Invalid original font directory entry/);
});
