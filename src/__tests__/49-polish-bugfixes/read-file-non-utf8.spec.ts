// 数据安全(独立审计):readFile 无条件 `toString('utf-8')`,非 UTF-8 文件(GBK / Latin-1 / 二进制)的
// 非法字节被替换成 U+FFFD;编辑器打开后保存写回 EF BF BD → 原文件被不可逆损坏。修复(参考 VSCode
// 「二进制 / 不支持的编码不在文本编辑器中打开」):编辑器使用的 fs:read-file 入口(requireUtf8)
// 检测非法 UTF-8 → 抛 FS_NOT_UTF8,renderer 打开走既有失败提示、不进入可保存的编辑 tab。
// 后续(editor-text-encoding):像文本的非 UTF-8(GBK 等)改报 FS_UNKNOWN_ENCODING(可通过编码重新打开),二进制仍报
// FS_NOT_UTF8;读取结果带 encoding,UTF-8 BOM 由 encoding='utf8bom' 表示(文本不含 BOM,保存时写回)。插件 fs readFile 契约不变。

import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readFile, readFileFromHandle } from '../../../electron/main/ipc/fs/read-file';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { en } from '../../../electron/shared/i18n-locales/en';
import { zh } from '../../../electron/shared/i18n-locales/zh';
import { ko } from '../../../electron/shared/i18n-locales/ko';
import { setupTempDirs } from '../_helpers/tmp-dir';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
}));

async function tempFile(bytes: Uint8Array | string): Promise<string> {
  const d = await tmp.make('continuo-read-utf8-');
  const f = join(d, 'f.txt');
  await writeFile(f, bytes);
  return f;
}
const tmp = setupTempDirs();

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
// 二进制:前 512 字节里有不成 UTF-16 规律的 0 字节
const BINARY = new Uint8Array([0x89, 0x50, 0x00, 0x00, 0x0d, 0x0a, 0x1a, 0x00]);

describe('readFile requireUtf8:非法 UTF-8 拒绝打开', () => {
  it('二进制字节 → FS_NOT_UTF8', async () => {
    const f = await tempFile(BINARY);
    expect(await codeOf(readFile(f))).toBe('FS_NOT_UTF8');
  });

  it('GBK 字节(像文本但不是 UTF-8)→ FS_UNKNOWN_ENCODING,不宽松解码', async () => {
    const f = await tempFile(GBK);
    expect(await codeOf(readFile(f))).toBe('FS_UNKNOWN_ENCODING');
  });

  it('合法 UTF-8 照常返回', async () => {
    const f = await tempFile('hello 世界');
    expect(await readFile(f)).toEqual({ content: 'hello 世界', encoding: 'utf8' });
  });

  it('UTF-8 BOM → encoding utf8bom,文本不含 U+FEFF', async () => {
    const f = await tempFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
    expect(await readFile(f)).toEqual({ content: 'a', encoding: 'utf8bom' });
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
  it('readFileHandler 对二进制抛 FS_NOT_UTF8、对非 UTF-8 文本抛 FS_UNKNOWN_ENCODING', async () => {
    const { readFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    expect(await codeOf(readFileHandler({ path: await tempFile(BINARY) }))).toBe('FS_NOT_UTF8');
    expect(await codeOf(readFileHandler({ path: await tempFile(GBK) }))).toBe('FS_UNKNOWN_ENCODING');
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
