// js-debug adapter 缓存完整性:scripts/fetch-debug-adapter.mjs 以前只要 dapDebugServer.js 存在就跳过
// sha256 校验,被改动过的本地 js-debug/ 会被原样打进安装包;校验与解包也读的不是同一份数据。
// 现在:内存 buffer 校验后用同一 buffer 解包,解包后写缓存标记(版本 + sha256 + 目录树哈希),
// 命中缓存须标记全部吻合。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'fetch-debug-adapter.mjs');

interface Pinned {
  version: string;
  sha256: string;
}
interface FetchModule {
  sha256Hex(buf: Buffer): string;
  writeCacheMarker(root: string, pinned: Pinned): Promise<void>;
  isCacheValid(root: string, pinned: Pinned): Promise<boolean>;
}

const PINNED: Pinned = { version: 'v1.117.0', sha256: 'a'.repeat(64) };
const MARKER = '.continuo-adapter-cache.json';

let mod: FetchModule;
let root: string;

beforeEach(async () => {
  const url = pathToFileURL(SCRIPT).href;
  mod = (await import(url)) as FetchModule;
  root = mkdtempSync(join(tmpdir(), 'continuo-adapter-cache-'));
  mkdirSync(join(root, 'js-debug', 'src'), { recursive: true });
  writeFileSync(join(root, 'js-debug', 'src', 'dapDebugServer.js'), 'module.exports = 1;\n');
  writeFileSync(join(root, 'js-debug', 'package.json'), '{ "type": "commonjs" }\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fetch-debug-adapter:缓存命中须核对标记', () => {
  it('解包后写入标记 → 同版本同 sha256 命中缓存', async () => {
    await mod.writeCacheMarker(root, PINNED);
    const marker = JSON.parse(readFileSync(join(root, MARKER), 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({ version: PINNED.version, sha256: PINNED.sha256 });
    expect(marker.treeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await mod.isCacheValid(root, PINNED)).toBe(true);
  });

  it('没有标记(旧缓存 / 手工放入的目录)→ 不命中', async () => {
    expect(await mod.isCacheValid(root, PINNED)).toBe(false);
  });

  it('标记版本或 sha256 与当前钉死值不同 → 不命中', async () => {
    await mod.writeCacheMarker(root, PINNED);
    expect(await mod.isCacheValid(root, { ...PINNED, version: 'v1.118.0' })).toBe(false);
    expect(await mod.isCacheValid(root, { ...PINNED, sha256: 'b'.repeat(64) })).toBe(false);
  });

  it.each([
    ['改动已有文件', (r: string) => writeFileSync(join(r, 'js-debug', 'src', 'dapDebugServer.js'), 'evil();\n')],
    ['新增文件', (r: string) => writeFileSync(join(r, 'js-debug', 'src', 'extra.js'), 'x')],
    ['删除文件', (r: string) => rmSync(join(r, 'js-debug', 'package.json'))],
    ['加入符号链接', (r: string) => symlinkSync('/etc/hosts', join(r, 'js-debug', 'link'))],
  ])('标记写入后 js-debug/ 被%s → 不命中(将删除重下)', async (_n, tamper) => {
    await mod.writeCacheMarker(root, PINNED);
    tamper(root);
    expect(await mod.isCacheValid(root, PINNED)).toBe(false);
  });

  it('标记内容损坏 → 不命中', async () => {
    writeFileSync(join(root, MARKER), '{not json');
    expect(await mod.isCacheValid(root, PINNED)).toBe(false);
  });

  it('sha256 校验与解包使用同一份内存 buffer,不落可预测临时文件', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/os\.tmpdir|tmpdir\(\)/);
    expect(src).toContain('actualSha = sha256Hex(source.buffer)');
    expect(src).toContain('parseTarGz(source.buffer)');
    expect(mod.sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
