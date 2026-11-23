// 数据安全(独立审计):readFile 无条件 `toString('utf-8')`,非 UTF-8 文件(GBK / Latin-1 / 二进制)的
// 非法字节被替换成 U+FFFD;编辑器打开后保存写回 EF BF BD → 原文件被不可逆损坏。修复(参考 VSCode
// 「二进制 / 不支持的编码不在文本编辑器中打开」):编辑器使用的 fs:read-file 入口(requireUtf8)
// 检测非法 UTF-8 → 抛 FS_NOT_UTF8,renderer 打开走既有失败提示、不进入可保存的编辑 tab。
// UTF-8 BOM 处理保持现状(BOM 原样保留在文本里)。插件 fs readFile 契约不变(不加检测)。

import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, readFileFromHandle } from '../../../electron/main/ipc/fs/read-file';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
}));

const dirs: string[] = [];
async function tempFile(bytes: Uint8Array | string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'continuo-read-utf8-'));
  dirs.push(d);
  const f = join(d, 'f.txt');
  await writeFile(f, bytes);
  return f;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

// GBK 编码的「中文」
const GBK = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);

describe('readFile requireUtf8:非法 UTF-8 拒绝打开', () => {
  it('GBK 字节 → FS_NOT_UTF8', async () => {
    const f = await tempFile(GBK);
    expect(await codeOf(readFile(f))).toBe('FS_NOT_UTF8');
  });

  it('合法 UTF-8 照常返回', async () => {
    const f = await tempFile('hello 世界');
    expect(await readFile(f)).toBe('hello 世界');
  });

  it('UTF-8 BOM 保持现状(原样保留 U+FEFF)', async () => {
    const f = await tempFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
    expect(await readFile(f)).toBe('﻿a');
  });

  it('插件 fs 的读取入口(readFileFromHandle,不传选项)保持宽松解码', async () => {
    const f = await tempFile(GBK);
    const fh = await open(f, 'r');
    try {
      expect(await readFileFromHandle(fh, f)).toContain('�');
    } finally {
      await fh.close();
    }
  });
});

describe('fs:read-file IPC handler(编辑器入口)启用 UTF-8 检测', () => {
  it('readFileHandler 对非法 UTF-8 抛 FS_NOT_UTF8', async () => {
    const { readFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    const f = await tempFile(GBK);
    expect(await codeOf(readFileHandler({ path: f }))).toBe('FS_NOT_UTF8');
  });
});

describe('FS_NOT_UTF8 错误码与三语文案', () => {
  it('ERROR_CODES 含 FS_NOT_UTF8,en/zh/ko 都有 errors.FS_NOT_UTF8', () => {
    expect((ERROR_CODES as Record<string, string>).FS_NOT_UTF8).toBe('FS_NOT_UTF8');
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      expect(cat['errors.FS_NOT_UTF8']).toBeTruthy();
    }
  });
});
