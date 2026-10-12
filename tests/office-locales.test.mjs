import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';
import { pruneOfficeAssets } from '../scripts/prune-office-assets.mjs';

test('Monaco loads Chinese NLS before editor.main and falls back to English safely', async () => {
  const source = await fs.readFile(new URL('../web-apps/vendor/monaco/monaco.js', import.meta.url), 'utf8');
  for (const { search, parentSearch, crossOrigin, expected } of [
    { search: '', parentSearch: '?lang=zh', expected: 'zh-cn' },
    { search: '', parentSearch: '?lang=en', expected: undefined },
    { search: '?uiLocale=zh-CN', parentSearch: '?lang=en', expected: 'zh-cn' },
    { search: '?uiLocale=en', parentSearch: '?lang=zh', expected: undefined },
    { search: '', crossOrigin: true, expected: undefined },
  ]) {
    let script;
    let configured;
    const parent = crossOrigin
      ? Object.defineProperty({}, 'location', { get() { throw new Error('cross-origin'); } })
      : { location: { search: parentSearch } };
    const require = modules => {
      assert.deepEqual(Array.from(modules), ['vs/editor/editor.main']);
      assert.ok(configured, 'NLS must be configured before editor.main loads');
      assert.equal(configured['vs/nls']?.availableLanguages['*'], expected);
    };
    require.config = config => { configured = config; };
    vm.runInNewContext(source, {
      window: { location: { search }, parent },
      document: {
        currentScript: { src: 'https://office.example/web-apps/vendor/monaco/monaco.js' },
        createElement: () => ({}),
        head: { appendChild: element => { script = element; } },
      },
      URLSearchParams,
      require,
    });
    script.onload();
  }
});

test('default pruning retains English and Simplified Chinese UI resources', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'office-locales-'));
  const localeDir = path.join(root, 'web-apps/apps/documenteditor/main/locale');
  const monacoDir = path.join(root, 'web-apps/vendor/monaco/monaco/min/vs');
  try {
    await fs.mkdir(localeDir, { recursive: true });
    await fs.mkdir(monacoDir, { recursive: true });
    for (const locale of ['en', 'zh', 'zh-tw', 'fr']) {
      await fs.writeFile(path.join(localeDir, `${locale}.json`), '{}');
    }
    for (const locale of ['en', 'zh-cn', 'zh-tw', 'fr']) {
      await fs.writeFile(path.join(monacoDir, `nls.messages.${locale}.js`), '');
    }
    await pruneOfficeAssets(root);
    assert.deepEqual((await fs.readdir(localeDir)).sort(), ['en.json', 'zh.json']);
    assert.deepEqual((await fs.readdir(monacoDir)).sort(), ['nls.messages.en.js', 'nls.messages.zh-cn.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('every shipped editor UI has Chinese translations covered by the integrity manifest', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'wasm-integrity-manifest.json'), 'utf8'));
  let checked = 0;
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name !== 'locale') {
        await walk(target);
        continue;
      }
      const files = await fs.readdir(target);
      if (!files.includes('en.json')) continue;
      const chinesePath = path.join(target, 'zh.json');
      const chinese = JSON.parse(await fs.readFile(chinesePath, 'utf8'));
      const english = JSON.parse(await fs.readFile(path.join(target, 'en.json'), 'utf8'));
      assert.ok(Object.keys(chinese).length > 0);
      function checkTranslations(source, translated, prefix = '') {
        for (const [key, value] of Object.entries(source)) {
          const messageKey = `${prefix}${key}`;
          const actual = translated?.[key];
          if (path.basename(path.dirname(target)) === 'embed') {
            assert.ok(actual !== undefined, `Missing embedded UI translation: ${chinesePath}: ${messageKey}`);
          }
          if (actual === undefined) continue;
          if (typeof value === 'string') {
            assert.equal(typeof actual, 'string', `Invalid translation: ${chinesePath}: ${messageKey}`);
            const placeholders = text => [...text.matchAll(/\{\d+\}|%\d+/g)].map(match => match[0]).sort();
            assert.deepEqual(placeholders(actual), placeholders(value), `Translation placeholders: ${chinesePath}: ${messageKey}`);
          } else if (value && typeof value === 'object') {
            assert.ok(actual && typeof actual === 'object', `Invalid nested translation: ${chinesePath}: ${messageKey}`);
            checkTranslations(value, actual, `${messageKey}.`);
          }
        }
      }
      checkTranslations(english, chinese);
      assert.ok(manifest.files[`vendor/office/${path.relative(root, chinesePath).split(path.sep).join('/')}`]);
      checked++;
    }
  }
  await walk(path.join(root, 'web-apps/apps'));
  assert.equal(checked, 14);
  assert.ok(manifest.files['vendor/office/web-apps/vendor/monaco/monaco/min/vs/nls.messages.zh-cn.js']);
});
