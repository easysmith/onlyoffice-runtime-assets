import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ALL_FONTS = 'sdkjs/common/AllFonts.js';
export const CHINESE_FONT_ALIASES = {
  宋体: 'SimSun',
  黑体: 'SimHei',
  仿宋: 'FangSong',
  楷体: 'KaiTi',
  新宋体: 'NSimSun',
  微软雅黑: 'Microsoft YaHei',
};
export const CHINESE_FALLBACK = 'WenQuanYi Zen Hei';
export const FONT_CACHE_SUFFIX = '_localfix_v3_cjk';
// The bundled SDK XORs the first 32 bytes of font downloads with this key.
const FONT_KEY = [160, 102, 214, 32, 20, 150, 71, 250, 149, 105, 184, 80, 176, 65, 73, 72];

export async function readFontCatalog(root) {
  const source = await fs.readFile(path.join(root, ALL_FONTS), 'utf8');
  const window = {};
  vm.runInNewContext(source, { window }, { timeout: 1000 });
  assert.equal(window.__all_fonts_js_version__, 2, 'Unsupported AllFonts format');
  return { source, catalog: window };
}

// Read real Unicode cmap entries, rather than trusting file size or OS/2 coverage flags.
export async function fontCodepoints(root, catalog, info) {
  const data = await fs.readFile(path.join(root, 'fonts', catalog.__fonts_files[info[1]]));
  for (let i = 0; i < Math.min(32, data.length); i++) data[i] ^= FONT_KEY[i % 16];
  const offset = data.toString('ascii', 0, 4) === 'ttcf' ? data.readUInt32BE(12 + info[2] * 4) : 0;
  let cmap;
  for (let i = 0; i < data.readUInt16BE(offset + 4); i++) {
    const table = offset + 12 + i * 16;
    if (data.toString('ascii', table, table + 4) === 'cmap') cmap = data.readUInt32BE(table + 8);
  }
  assert.notEqual(cmap, undefined, `Missing cmap: ${info[0]}`);
  const codepoints = new Set();
  for (let i = 0; i < data.readUInt16BE(cmap + 2); i++) {
    const record = cmap + 4 + i * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const table = cmap + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(table);
    if (format === 4) {
      const count = data.readUInt16BE(table + 6) / 2;
      for (let segment = 0; segment < count; segment++) {
        const end = data.readUInt16BE(table + 14 + segment * 2);
        const start = data.readUInt16BE(table + 16 + count * 2 + segment * 2);
        const delta = data.readInt16BE(table + 16 + count * 4 + segment * 2);
        const rangeWord = table + 16 + count * 6 + segment * 2;
        const range = data.readUInt16BE(rangeWord);
        for (let cp = start; cp <= end && cp < 0xffff; cp++) {
          let glyph = range ? data.readUInt16BE(rangeWord + range + 2 * (cp - start)) : cp;
          if (!range || glyph) glyph = (glyph + delta) & 0xffff;
          if (glyph) codepoints.add(cp);
        }
      }
    } else if (format === 12) {
      for (let group = 0; group < data.readUInt32BE(table + 12); group++) {
        const at = table + 16 + group * 12;
        const start = data.readUInt32BE(at);
        const end = data.readUInt32BE(at + 4);
        const glyph = data.readUInt32BE(at + 8);
        assert.ok(end <= 0x10ffff, 'Invalid Unicode cmap range');
        for (let cp = start; cp <= end; cp++) if (glyph + cp - start) codepoints.add(cp);
      }
    }
  }
  assert.ok(codepoints.size, `No supported Unicode cmap: ${info[0]}`);
  return codepoints;
}

export function selectionRecords(base64) {
  const data = Buffer.from(base64, 'base64');
  const records = [];
  let offset = 4;
  for (let i = 0; i < data.readUInt32LE(0); i++) {
    const start = offset;
    const size = data.readUInt32LE(offset);
    offset += 4;
    const readString = () => {
      const length = data.readUInt32LE(offset);
      offset += 4;
      const value = data.toString('utf8', offset, offset + length);
      offset += length;
      return value;
    };
    const name = readString();
    const aliases = data.readUInt32LE(offset);
    offset += 4;
    for (let j = 0; j < aliases; j++) readString();
    readString(); // Retain the alias's unique source path; copy canonical face metrics below.
    assert.ok(size > offset - start && start + size <= data.length, 'Invalid font selection record');
    records.push({ name, header: data.subarray(start, offset), metrics: data.subarray(offset, start + size) });
    offset = start + size;
  }
  assert.equal(offset, data.length, 'Unexpected font selection data');
  return records;
}

function isChineseCodepoint(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x303f) ||
    (cp >= 0x31c0 && cp <= 0x31ef) ||
    (cp >= 0x3400 && cp <= 0x9fff && !(cp >= 0x4dc0 && cp <= 0x4dff)) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

// Serialized into x2t_helper.js; only use browser globals and the converter's FS.
export async function copyLoadedFontsToConverter() {
  const fonts = window.AscFonts;
  if (!fonts || !fonts.getFontStreams || !fonts.getFontStream) {
    throw new Error('Office font streams are unavailable');
  }
  const streams = fonts.getFontStreams();
  for (let index = 0; index < streams.length; index++) {
    // getFontStream also expands compressed embedded fonts. These bytes have
    // already passed through the SDK decoder, unlike raw /fonts/ downloads.
    const font = fonts.getFontStream(index);
    this.x2tModule.FS.writeFile(`/working/fonts/loaded-${index}.ttf`, font.data.subarray(0, font.size));
  }
}

export async function repairChineseFonts(root) {
  const { source, catalog } = await readFontCatalog(root);
  const infos = catalog.__fonts_infos;
  const byName = new Map(infos.map(info => [info[0], info]));
  const sample = '中国大陆中文字体测试，。';
  for (const [alias, canonical] of Object.entries(CHINESE_FONT_ALIASES)) {
    assert.ok(byName.has(alias) && byName.has(canonical), `Missing font pair: ${alias}/${canonical}`);
    const target = byName.get(canonical);
    const covered = await fontCodepoints(root, catalog, target);
    assert.ok(
      [...sample].every(char => covered.has(char.codePointAt(0))),
      `Incomplete font: ${canonical}`,
    );
    byName.get(alias).splice(1, 8, ...target.slice(1));
  }

  const fallbackIndex = infos.findIndex(info => info[0] === CHINESE_FALLBACK);
  assert.ok(fallbackIndex >= 0, 'Missing Chinese fallback font');
  const covered = await fontCodepoints(root, catalog, infos[fallbackIndex]);
  const ranges = [];
  const old = catalog.__fonts_ranges;
  for (let i = 0; i < old.length; i += 3) {
    for (let cp = old[i]; cp <= old[i + 1]; cp++) {
      const font = isChineseCodepoint(cp) && covered.has(cp) ? fallbackIndex : old[i + 2];
      const end = ranges.length;
      if (end && ranges[end - 1] === font && ranges[end - 2] + 1 === cp) ranges[end - 2] = cp;
      else ranges.push(cp, cp, font);
    }
  }

  const records = selectionRecords(catalog.g_fonts_selection_bin);
  const buffers = records.map(record => {
    const canonical = CHINESE_FONT_ALIASES[record.name];
    const target = canonical ? records.find(item => item.name === canonical) : record;
    assert.ok(target, `Missing font selection metadata: ${canonical}`);
    const result = Buffer.concat([record.header, target.metrics]);
    result.writeUInt32LE(result.length, 0);
    return result;
  });
  const count = Buffer.alloc(4);
  count.writeUInt32LE(records.length);
  const selection = Buffer.concat([count, ...buffers]).toString('base64');
  const output = source
    .replace(/window\["__fonts_infos"\] = \[[\s\S]*?\];/, `window["__fonts_infos"] = [\n${infos.map(info => JSON.stringify(info)).join(',\n')}\n];`)
    .replace(/window\["__fonts_ranges"\] = \[[\s\S]*?\];/, `window["__fonts_ranges"] = [\n${ranges.join(',')}\n];`)
    .replace(/window\["g_fonts_selection_bin"\] = "[^"]*";/, `window["g_fonts_selection_bin"] = "${selection}";`);
  const workerPath = path.join(root, 'document_editor_service_worker.js');
  const worker = await fs.readFile(workerPath, 'utf8');
  const patched = worker.replace(
    /var g_cacheName=g_cacheNamePrefix\+g_version(?:\+"[^"]*")?;/,
    `var g_cacheName=g_cacheNamePrefix+g_version+"${FONT_CACHE_SUFFIX}";`,
  );
  assert.ok(patched.includes(`g_version+"${FONT_CACHE_SUFFIX}";`), 'Unrecognized worker cache declaration');

  const helperPath = path.join(root, 'sdkjs/common/wasm/x2t/x2t_helper.js');
  const helper = await fs.readFile(helperPath, 'utf8');
  const fetchStart = helper.indexOf('    X2TConverter.prototype.fetchFonts = ');
  const fetchEnd = helper.indexOf('    X2TConverter.prototype.convertFromBin = ', fetchStart);
  assert.ok(fetchStart >= 0 && fetchEnd > fetchStart, 'Unrecognized x2t font loader');
  const patchedHelper =
    helper.slice(0, fetchStart) + `    X2TConverter.prototype.fetchFonts = ${copyLoadedFontsToConverter.toString()};\n\n` + helper.slice(fetchEnd);

  await fs.writeFile(path.join(root, ALL_FONTS), output);
  await fs.writeFile(workerPath, patched);
  await fs.writeFile(helperPath, patchedHelper);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 0 || (args.length === 2 && args[0] === '--asset-root'),
    'Usage: node scripts/repair-chinese-fonts.mjs [--asset-root <dir>]',
  );
  await repairChineseFonts(path.resolve(args[1] || '.'));
  console.log('Repaired Chinese fonts, PDF font handoff, and worker cache version.');
}
