import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const YAHEI_PACK_PATH = 'font-packs/microsoft-yahei.json';
export const YAHEI_NAMES = ['Microsoft YaHei', '微软雅黑'];

export async function readYaHeiPack(root) {
  const pack = JSON.parse(await fs.readFile(path.join(root, YAHEI_PACK_PATH), 'utf8'));
  assert.equal(pack.version, 1, 'Unsupported YaHei pack metadata');
  assert.equal(pack.faces.length, 2, 'YaHei regular and bold are required');
  assert.deepEqual(pack.faces.map(face => face.slot), [1, 5]);
  for (const face of pack.faces) {
    assert.match(face.file, /^yahei-[a-z0-9-]+$/, 'Unsafe YaHei filename');
    assert.equal(Buffer.from(face.metrics, 'base64').length, 76, 'Unexpected font selection metrics');
  }
  return pack;
}

// Also used before an upstream sync removes the old fonts directory.
export async function readYaHeiPayloads(root) {
  const pack = await readYaHeiPack(root);
  return Promise.all(pack.faces.map(async face => {
    const data = await fs.readFile(path.join(root, 'fonts', face.file));
    assert.equal(createHash('sha256').update(data).digest('hex'), face.sha256, `Corrupt YaHei font: ${face.file}`);
    return { file: face.file, data };
  }));
}

function encodeString(value) {
  const data = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([length, data]);
}

// Preserve family indices used by fallback ranges and all unrelated font records.
// Metrics come from allfontsgen, including distinct regular/bold flags and widths.
export async function applyYaHeiPack(root, catalog, records) {
  const pack = await readYaHeiPack(root);
  await readYaHeiPayloads(root);
  const faces = [-1, -1, -1, -1, -1, -1, -1, -1];
  for (const face of pack.faces) {
    let index = catalog.__fonts_files.indexOf(face.file);
    if (index < 0) index = catalog.__fonts_files.push(face.file) - 1;
    faces[face.slot - 1] = index;
    faces[face.slot] = 0;
  }
  for (const name of YAHEI_NAMES) {
    const info = catalog.__fonts_infos.find(info => info[0] === name);
    assert.ok(info, `Missing font family: ${name}`);
    info.splice(1, 8, ...faces);
  }
  const output = records.filter(record => !YAHEI_NAMES.includes(record.name));
  for (const name of YAHEI_NAMES) {
    for (const face of pack.faces) {
      const metrics = Buffer.from(face.metrics, 'base64');
      const header = Buffer.concat([Buffer.alloc(4), encodeString(name), Buffer.alloc(4), encodeString(face.file)]);
      header.writeUInt32LE(header.length + metrics.length);
      output.push({ name, header, metrics });
    }
  }
  return output;
}
