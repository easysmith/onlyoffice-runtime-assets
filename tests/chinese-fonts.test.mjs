import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { copyRequiredDirectories } from '../scripts/sync-office-assets.mjs';
import { readYaHeiPack } from '../scripts/yahei-font-pack.mjs';
import {
  CHINESE_FONT_ALIASES,
  CHINESE_FALLBACK,
  FONT_CACHE_SUFFIX,
  copyLoadedFontsToConverter,
  fontCodepoints,
  readFontCatalog,
  repairChineseFonts,
  selectionRecords,
} from '../scripts/repair-chinese-fonts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { catalog } = await readFontCatalog(root);
const byName = new Map(catalog.__fonts_infos.map(info => [info[0], info]));

// Keep this regression list independent of the repair map: removing a mapping
// must fail, even if both the generator and its generic tests use that map.
const officeAliases = {
  华文宋体: ['STSong', '036'],
  华文仿宋: ['STFangsong', '032'],
  华文楷体: ['STKaiti', '034'],
  华文细黑: ['STXihei', '037'],
  华文中宋: ['STZhongsong', '040'],
  华文行楷: ['STXingkai', '038'],
  华文隶书: ['STLiti', '035'],
  华文新魏: ['STXinwei', '039'],
  华文彩云: ['STCaiyun', '031'],
  华文琥珀: ['STHupo', '033'],
  方正舒体: ['FZShuTi', '027'],
  方正姚体: ['FZYaoTi', '029'],
  隶书: ['LiSu', '043'],
  幼圆: ['YouYuan', '048'],
};

function gb2312Han() {
  const decoder = new TextDecoder('gb18030');
  const han = new Set();
  for (let lead = 0xb0; lead <= 0xf7; lead++) {
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      const cp = decoder.decode(Uint8Array.of(lead, trail)).codePointAt(0);
      if (cp >= 0x4e00 && cp <= 0x9fff) han.add(cp);
    }
  }
  assert.equal(han.size, 6763);
  return han;
}

for (const [alias, [canonical]] of Object.entries(officeAliases)) {
  test(`${alias} resolves to ${canonical} with complete GB2312 Han coverage`, async () => {
    assert.equal(CHINESE_FONT_ALIASES[alias], canonical);
    const info = byName.get(alias);
    assert.deepEqual(info.slice(1), byName.get(canonical).slice(1));
    for (const slot of [1, 3, 5, 7]) {
      if (info[slot] < 0) continue;
      const covered = await fontCodepoints(root, catalog, [alias, info[slot], info[slot + 1]]);
      for (const cp of gb2312Han()) {
        assert.ok(covered.has(cp), `${alias} slot ${slot} missing U+${cp.toString(16)}`);
      }
      for (const char of 'ABCxyz0123，。！？') {
        assert.ok(covered.has(char.codePointAt(0)), `${alias} slot ${slot} missing ${char}`);
      }
    }
  });
}

test('Chinese family names resolve to real glyphs and the canonical faces', async () => {
  for (const [alias, canonical] of Object.entries(CHINESE_FONT_ALIASES)) {
    const covered = await fontCodepoints(root, catalog, byName.get(alias));
    for (const char of '中国大陆中文字体测试，。') {
      assert.ok(covered.has(char.codePointAt(0)), `${alias} is missing ${char}`);
    }
    assert.equal(JSON.stringify(byName.get(alias).slice(1)), JSON.stringify(byName.get(canonical).slice(1)));
  }
});

test('Chinese font selection uses the canonical face metrics', () => {
  const records = new Map(selectionRecords(catalog.g_fonts_selection_bin).map(record => [record.name, record]));
  for (const [alias, canonical] of Object.entries(CHINESE_FONT_ALIASES)) {
    assert.deepEqual(records.get(alias).metrics, records.get(canonical).metrics, alias);
  }
});

test('YaHei regular and bold cover GB2312 Han and the presentation regressions', async () => {
  const han = gb2312Han();
  for (const name of ['Microsoft YaHei', '微软雅黑']) {
    const info = byName.get(name);
    assert.ok(info[5] >= 0 && info[5] !== info[1], 'A real bold font is required');
    for (const slot of [1, 5]) {
      const cps = await fontCodepoints(root, catalog, [name, info[slot], info[slot + 1]]);
      for (const cp of han) assert.ok(cps.has(cp), `${name} slot ${slot} missing U+${cp.toString(16)}`);
      for (const char of '荣昌辉一冉贫辈懈奋逢凝融勃焕丽岗礴砥砺铭喆镕龘') {
        assert.ok(cps.has(char.codePointAt(0)), `${name} missing ${char}`);
      }
    }
  }
});

test('YaHei selection metadata preserves distinct regular and bold metrics for both names', async () => {
  const pack = await readYaHeiPack(root);
  const records = selectionRecords(catalog.g_fonts_selection_bin);
  for (const name of ['Microsoft YaHei', '微软雅黑']) {
    const faces = records.filter(record => record.name === name);
    assert.equal(faces.length, 2);
    for (let i = 0; i < faces.length; i++) {
      assert.deepEqual(faces[i].metrics, Buffer.from(pack.faces[i].metrics, 'base64'));
      assert.equal(faces[i].metrics.readInt32LE(8), i, 'Incorrect bold flag');
    }
  }
});

test('upstream asset copy preserves the licensed YaHei payloads', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'office-yahei-sync-'));
  try {
    const source = path.join(temp, 'source');
    const target = path.join(temp, 'target');
    for (const dir of ['fonts', 'sdkjs', 'web-apps']) {
      await fs.mkdir(path.join(source, dir), { recursive: true });
      await fs.writeFile(path.join(source, dir, 'upstream'), 'upstream');
      await fs.mkdir(path.join(target, dir), { recursive: true });
    }
    await fs.cp(path.join(root, 'font-packs'), path.join(target, 'font-packs'), { recursive: true });
    const pack = await readYaHeiPack(root);
    for (const face of pack.faces) {
      await fs.copyFile(path.join(root, 'fonts', face.file), path.join(target, 'fonts', face.file));
    }
    await copyRequiredDirectories(source, target);
    for (const face of pack.faces) {
      const data = await fs.readFile(path.join(target, 'fonts', face.file));
      assert.equal(createHash('sha256').update(data).digest('hex'), face.sha256);
    }
    const fresh = path.join(temp, 'fresh');
    await copyRequiredDirectories(source, fresh);
    assert.deepEqual(await readYaHeiPack(fresh), pack);
    for (const face of pack.faces) {
      const data = await fs.readFile(path.join(fresh, 'fonts', face.file));
      assert.equal(createHash('sha256').update(data).digest('hex'), face.sha256);
    }
    assert.equal(await fs.readFile(path.join(target, 'fonts/upstream'), 'utf8'), 'upstream');
    await fs.writeFile(path.join(target, 'fonts', pack.faces[0].file), 'corrupt');
    await assert.rejects(copyRequiredDirectories(source, target), /Corrupt YaHei font/);
    assert.equal(await fs.readFile(path.join(target, 'fonts/upstream'), 'utf8'), 'upstream');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Chinese fallback has the requested glyphs, including the formerly decorative fallback', async () => {
  const covered = await fontCodepoints(root, catalog, byName.get(CHINESE_FALLBACK));
  for (const char of '中国大陆中文字体测试龘喆镕，。') {
    const cp = char.codePointAt(0);
    const ranges = catalog.__fonts_ranges;
    const index = ranges.findIndex((start, i) => i % 3 === 0 && cp >= start && cp <= ranges[i + 1]);
    assert.ok(index >= 0, `Missing range for ${char}`);
    assert.equal(catalog.__fonts_infos[ranges[index + 2]][0], CHINESE_FALLBACK, char);
    assert.ok(covered.has(cp), `Fallback missing ${char}`);
  }
  const ranges = catalog.__fonts_ranges;
  for (let i = 0; i < ranges.length; i += 3) {
    assert.ok(ranges[i] <= ranges[i + 1]);
    if (i) assert.ok(ranges[i] > ranges[i - 2], 'Ranges must remain ordered and disjoint');
    if (catalog.__fonts_infos[ranges[i + 2]][0] !== CHINESE_FALLBACK) continue;
    for (let cp = ranges[i]; cp <= ranges[i + 1]; cp++) assert.ok(covered.has(cp), `Missing U+${cp.toString(16)}`);
  }
});

test('every indexed font payload has a matching integrity hash', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'wasm-integrity-manifest.json'), 'utf8'));
  for (const file of catalog.__fonts_files) {
    const bytes = await fs.readFile(path.join(root, 'fonts', file));
    assert.equal(manifest.files[`vendor/office/fonts/${file}`], createHash('sha256').update(bytes).digest('hex'), file);
  }
});

test('repair is repeatable and upgrades the old worker cache', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'office-cjk-test-'));
  try {
    await fs.mkdir(path.join(temp, 'sdkjs/common'), { recursive: true });
    await fs.mkdir(path.join(temp, 'sdkjs/common/wasm/x2t'), { recursive: true });
    const helper = 'sdkjs/common/wasm/x2t/x2t_helper.js';
    await fs.copyFile(path.join(root, helper), path.join(temp, helper));
    await fs.symlink(path.join(root, 'fonts'), path.join(temp, 'fonts'));
    await fs.cp(path.join(root, 'font-packs'), path.join(temp, 'font-packs'), { recursive: true });
    const relative = 'sdkjs/common/AllFonts.js';
    const before = await readFontCatalog(root);
    const brokenInfos = before.catalog.__fonts_infos.map(info => {
      const pair = officeAliases[info[0]];
      return pair ? [info[0], before.catalog.__fonts_files.indexOf(pair[1]), 0, -1, -1, -1, -1, -1, -1] : info;
    });
    const records = selectionRecords(before.catalog.g_fonts_selection_bin);
    const brokenRecords = records.map(record => {
      const metrics = officeAliases[record.name] ? Buffer.alloc(record.metrics.length) : record.metrics;
      return Buffer.concat([record.header, metrics]);
    });
    const count = Buffer.alloc(4);
    count.writeUInt32LE(records.length);
    const brokenSource = before.source
      .replace(/window\["__fonts_infos"\] = \[[\s\S]*?\];/, `window["__fonts_infos"] = ${JSON.stringify(brokenInfos)};`)
      .replace(/window\["g_fonts_selection_bin"\] = "[^"]*";/, `window["g_fonts_selection_bin"] = "${Buffer.concat([count, ...brokenRecords]).toString('base64')}";`);
    await fs.writeFile(path.join(temp, relative), brokenSource);
    await fs.writeFile(path.join(temp, 'document_editor_service_worker.js'), 'var g_cacheName=g_cacheNamePrefix+g_version+"_localfix_v4_yahei";');
    await repairChineseFonts(temp);
    const after = await readFontCatalog(temp);
    assert.equal(JSON.stringify(after.catalog.__fonts_files), JSON.stringify(before.catalog.__fonts_files), 'Payload indices must stay stable');
    assert.equal(JSON.stringify(after.catalog.__fonts_infos), JSON.stringify(before.catalog.__fonts_infos), 'Family names, order, and unrelated faces must stay stable');
    assert.equal(JSON.stringify(after.catalog.__fonts_ranges), JSON.stringify(before.catalog.__fonts_ranges), 'Fallbacks must not change');
    const repairedRecords = selectionRecords(after.catalog.g_fonts_selection_bin);
    assert.equal(repairedRecords.length, records.length);
    for (let i = 0; i < records.length; i++) {
      assert.deepEqual(repairedRecords[i].header, records[i].header, `${records[i].name} must retain its family identity and source path`);
      assert.deepEqual(repairedRecords[i].metrics, records[i].metrics, records[i].name);
    }
    const first = await fs.readFile(path.join(temp, relative), 'utf8');
    const firstHelper = await fs.readFile(path.join(temp, helper), 'utf8');
    await repairChineseFonts(temp);
    assert.equal(await fs.readFile(path.join(temp, relative), 'utf8'), first);
    assert.equal(await fs.readFile(path.join(temp, helper), 'utf8'), firstHelper);
    assert.ok((await fs.readFile(path.join(temp, 'document_editor_service_worker.js'), 'utf8')).includes(FONT_CACHE_SUFFIX));
    assert.ok((await fs.readFile(path.join(root, 'document_editor_service_worker.js'), 'utf8')).includes(FONT_CACHE_SUFFIX));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('PDF conversion receives all decoded font streams before it proceeds', async () => {
  const originalWindow = globalThis.window;
  const writes = [];
  const decoded = [new Uint8Array([0, 1, 0, 0, 99]), new Uint8Array([79, 84, 84, 79, 88])];
  globalThis.window = {
    AscFonts: {
      getFontStreams: () => [{}, {}],
      getFontStream: index => ({ data: decoded[index], size: 4 }),
    },
  };
  try {
    await copyLoadedFontsToConverter.call({
      x2tModule: {
        FS: {
          writeFile: (name, data) => writes.push([name, Array.from(data)]),
        },
      },
    });
    assert.deepEqual(writes, [
      ['/working/fonts/loaded-0.ttf', [0, 1, 0, 0]],
      ['/working/fonts/loaded-1.ttf', [79, 84, 84, 79]],
    ]);
    const helper = await fs.readFile(path.join(root, 'sdkjs/common/wasm/x2t/x2t_helper.js'), 'utf8');
    assert.ok(helper.includes(copyLoadedFontsToConverter.toString()), 'Bundled converter must use the repaired font handoff');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('worker activation removes the old font cache and retains unrelated caches', async () => {
  const events = {};
  const deleted = [];
  const current = `document_editor_static_office${FONT_CACHE_SUFFIX}`;
  const old = 'document_editor_static_office_localfix_v4_yahei';
  const worker = await fs.readFile(path.join(root, 'document_editor_service_worker.js'), 'utf8');
  vm.runInNewContext(worker, {
    console,
    navigator: { userAgent: 'Chromium' },
    self: {
      location: { pathname: '/vendor/office/document_editor_service_worker.js' },
      clients: { claim: async () => undefined },
      addEventListener: (name, callback) => {
        events[name] = callback;
      },
    },
    caches: {
      keys: async () => [old, current, 'application-cache'],
      delete: async name => {
        deleted.push(name);
        return true;
      },
    },
  });
  let activated;
  events.activate({
    waitUntil: promise => {
      activated = promise;
    },
  });
  await activated;
  assert.deepEqual(deleted, [old]);
});
