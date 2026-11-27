// 主进程编码层 + fs:read-file / fs:write-file 字节级往返。行为见同目录 README。
import { readFile as readBytes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it, vi } from 'vitest';
import { decodeTextFile, encodeTextFile } from '../../../electron/main/lib/text-codec';
import { encodingHasBom, isDecodableEncoding, TEXT_ENCODING_IDS, type TextEncodingId } from '../../../electron/shared/text-encoding';
import { setupTempDirs } from '../_helpers/tmp-dir';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {},
  shell: {},
}));

const tmp = setupTempDirs();
const bytes = (...b: number[]) => new Uint8Array(b);
const utf16le = (s: string) => new Uint8Array(Buffer.from(s, 'utf16le'));
const utf16be = (s: string) => {
  const le = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!];
  return new Uint8Array(le);
};
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const GBK_ZHONGWEN = bytes(0xd6, 0xd0, 0xce, 0xc4); // 「中文」
function encBytes(text: string, id: TextEncodingId): number[] {
  const r = encodeTextFile(text, id);
  if (!r.ok) throw new Error(`unencodable ${r.unencodable}`);
  return [...r.bytes];
}

async function tempFile(content: Uint8Array): Promise<string> {
  const d = await tmp.make('continuo-encoding-');
  const f = join(d, 'f.txt');
  await writeFile(f, content);
  return f;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe('decodeTextFile:自动识别(VSCode detectEncodingFromBuffer)', () => {
  it('BOM:UTF-8 / UTF-16 LE / UTF-16 BE,文本不含 BOM', () => {
    expect(decodeTextFile(concat(bytes(0xef, 0xbb, 0xbf), new TextEncoder().encode('a中')))).toEqual({
      ok: true,
      text: 'a中',
      encoding: 'utf8bom',
    });
    expect(decodeTextFile(concat(bytes(0xff, 0xfe), utf16le('a中\r\n')))).toEqual({
      ok: true,
      text: 'a中\r\n',
      encoding: 'utf16le',
    });
    expect(decodeTextFile(concat(bytes(0xfe, 0xff), utf16be('a中')))).toEqual({ ok: true, text: 'a中', encoding: 'utf16be' });
  });

  it('无 BOM 的 UTF-16:0 字节规律(前 512 字节)', () => {
    expect(decodeTextFile(utf16le('hello'))).toMatchObject({ ok: true, text: 'hello', encoding: 'utf16le' });
    expect(decodeTextFile(utf16be('hello'))).toMatchObject({ ok: true, text: 'hello', encoding: 'utf16be' });
  });

  it('其它位置有 0 字节 → 二进制;合法 UTF-8 → utf8;像文本但非 UTF-8 → unknown-encoding', () => {
    expect(decodeTextFile(bytes(0x89, 0x50, 0x00, 0x00, 0x41))).toEqual({ ok: false, reason: 'binary' });
    expect(decodeTextFile(new TextEncoder().encode('héllo'))).toEqual({ ok: true, text: 'héllo', encoding: 'utf8' });
    expect(decodeTextFile(GBK_ZHONGWEN)).toEqual({ ok: false, reason: 'unknown-encoding' });
    expect(decodeTextFile(bytes())).toEqual({ ok: true, text: '', encoding: 'utf8' });
  });

  it('UTF-16 BOM 后奇数字节 → 不可逆,decode-failed', () => {
    expect(decodeTextFile(bytes(0xff, 0xfe, 0x41, 0x00, 0x42))).toEqual({ ok: false, reason: 'decode-failed' });
  });
});

describe('decodeTextFile:指定编码(通过编码重新打开)', () => {
  it('GBK / Shift JIS / EUC-KR / Big5 / Windows-1252 / Latin-1 可逆解码', () => {
    expect(decodeTextFile(GBK_ZHONGWEN, 'gbk')).toEqual({ ok: true, text: '中文', encoding: 'gbk' });
    for (const [enc, text] of [
      ['shiftjis', '日本語テキスト'],
      ['eucjp', '日本語'],
      ['euckr', '한국어'],
      ['cp950', '繁體中文'],
      ['gb18030', '中文😀'],
      ['windows1252', 'café €'],
      ['iso88591', 'café ÿ'],
    ] as const) {
      expect(decodeTextFile(new Uint8Array(iconv.encode(text, enc)), enc)).toEqual({ ok: true, text, encoding: enc });
    }
  });

  it('不可逆(非法序列 / 未定义字节)→ decode-failed,不带替换字符打开', () => {
    expect(decodeTextFile(GBK_ZHONGWEN, 'utf8')).toEqual({ ok: false, reason: 'decode-failed' });
    expect(decodeTextFile(bytes(0x41, 0x81), 'windows1252')).toEqual({ ok: false, reason: 'decode-failed' });
    expect(decodeTextFile(bytes(0xd6), 'gbk')).toEqual({ ok: false, reason: 'decode-failed' });
  });

  it('指定 UTF-8 而文件带 UTF-8 BOM → utf8bom(VSCode getPreferredReadEncoding)', () => {
    expect(decodeTextFile(bytes(0xef, 0xbb, 0xbf, 0x61), 'utf8')).toEqual({ ok: true, text: 'a', encoding: 'utf8bom' });
  });
});

describe('encodeTextFile:BOM 规则与无损校验', () => {
  it('utf16le / utf16be / utf8bom 带 BOM,其它不带', () => {
    expect(encBytes('a', 'utf16le')).toEqual([0xff, 0xfe, 0x61, 0x00]);
    expect(encBytes('a', 'utf16be')).toEqual([0xfe, 0xff, 0x00, 0x61]);
    expect(encBytes('a', 'utf8bom')).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    expect(encBytes('a', 'utf8')).toEqual([0x61]);
    expect(encBytes('中文', 'gbk')).toEqual([...GBK_ZHONGWEN]);
    for (const id of TEXT_ENCODING_IDS) expect(encodingHasBom(id)).toBe(id === 'utf8bom' || id.startsWith('utf16'));
  });

  it('表示不了的字符 → 拒绝并给出第一个这样的字符(不静默写成 ?)', () => {
    expect(encodeTextFile('中文😀x', 'gbk')).toEqual({ ok: false, unencodable: '😀' });
    expect(encodeTextFile('price €', 'iso88591')).toEqual({ ok: false, unencodable: '€' });
    expect(encodeTextFile('中文😀', 'gb18030').ok).toBe(true);
  });

  it('可解码的编码:解码 → 编码 往返逐字节一致', () => {
    const samples: Record<string, string> = { koi8r: 'Привет', windows1251: 'Привет', windows1250: 'Łódź', iso885915: '€uro' };
    for (const [enc, text] of Object.entries(samples)) {
      const id = enc as TextEncodingId;
      expect(isDecodableEncoding(id)).toBe(true);
      expect(decodeTextFile(new Uint8Array(encBytes(text, id)), id)).toEqual({ ok: true, text, encoding: id });
    }
    expect(isDecodableEncoding('utf8bom')).toBe(false);
  });
});

describe('fs:read-file / fs:write-file 字节级往返', () => {
  it('UTF-16 LE / BE 带 BOM:读出编码与文本,编辑后保存只改动编辑处', async () => {
    const { readFileHandler, writeFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    for (const [enc, bom, encode] of [
      ['utf16le', bytes(0xff, 0xfe), utf16le],
      ['utf16be', bytes(0xfe, 0xff), utf16be],
    ] as const) {
      const f = await tempFile(concat(bom, encode('line1\r\n中文\r\n')));
      const r = await readFileHandler({ path: f });
      expect(r).toEqual({ content: 'line1\r\n中文\r\n', encoding: enc });
      await writeFileHandler({ path: f, content: 'line1\r\n中文!\r\n', encoding: enc });
      expect([...(await readBytes(f))]).toEqual([...concat(bom, encode('line1\r\n中文!\r\n'))]);
    }
  });

  it('GBK:自动识别报 FS_UNKNOWN_ENCODING;指定 gbk 打开、保存字节正确', async () => {
    const { readFileHandler, writeFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    const f = await tempFile(concat(GBK_ZHONGWEN, bytes(0x0a)));
    expect(await codeOf(readFileHandler({ path: f }))).toBe('FS_UNKNOWN_ENCODING');
    expect(await readFileHandler({ path: f, encoding: 'gbk' })).toEqual({ content: '中文\n', encoding: 'gbk' });
    await writeFileHandler({ path: f, content: '中文测试\n', encoding: 'gbk' });
    expect([...(await readBytes(f))]).toEqual([...iconv.encode('中文测试\n', 'gbk')]);
  });

  it('以 GBK 保存 emoji → FS_UNENCODABLE,原文件逐字节不变', async () => {
    const { writeFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    const original = concat(GBK_ZHONGWEN, bytes(0x0a));
    const f = await tempFile(original);
    expect(await codeOf(writeFileHandler({ path: f, content: '中文😀\n', encoding: 'gbk' }))).toBe('FS_UNENCODABLE');
    expect([...(await readBytes(f))]).toEqual([...original]);
  });

  it('UTF-8 BOM 文件:读出 utf8bom,保存写回 BOM;未知编码 id 被 schema 拒绝', async () => {
    const { readFileHandler, writeFileHandler, readFileInputSchema, writeFileInputSchema } = await import(
      '../../../electron/main/ipc/fs.ipc'
    );
    const f = await tempFile(bytes(0xef, 0xbb, 0xbf, 0x61));
    expect(await readFileHandler({ path: f })).toEqual({ content: 'a', encoding: 'utf8bom' });
    await writeFileHandler({ path: f, content: 'ab', encoding: 'utf8bom' });
    expect([...(await readBytes(f))]).toEqual([0xef, 0xbb, 0xbf, 0x61, 0x62]);
    expect(readFileInputSchema.safeParse({ path: f, encoding: 'ebcdic' }).success).toBe(false);
    expect(writeFileInputSchema.safeParse({ path: f, content: '', encoding: 'ebcdic' }).success).toBe(false);
  });

  it('二进制文件仍拒绝打开(FS_NOT_UTF8)', async () => {
    const { readFileHandler } = await import('../../../electron/main/ipc/fs.ipc');
    expect(await codeOf(readFileHandler({ path: await tempFile(bytes(0x00, 0x01, 0x00, 0x00, 0x7f, 0x45)) }))).toBe(
      'FS_NOT_UTF8',
    );
  });
});
