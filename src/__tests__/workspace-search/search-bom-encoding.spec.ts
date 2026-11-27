// BDD: workspace-search / 4 搜索引擎 · 带 BOM 的文件(VSCode:files.encoding 默认 utf8 时 ripgrep 按 BOM 嗅探 UTF-8 / UTF-16):
// UTF-16 LE / BE、UTF-8 BOM 按 BOM 解码后搜,BOM 不计入列号 —— 行 / 列 / 预览与编辑器打开后的内容(不含 BOM)同口径;
// 无 BOM 的 GBK / UTF-16 仍跳过(不猜编码);已打开编辑器的内存结果覆盖同一文件的磁盘结果。见同目录 README 4 / 6。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { runTextSearch } from '../../../electron/main/search/text-search';
import { mergeDiskBatch, searchOpenEditors } from '../../panels/Search/open-editor-search';
import {
  buildSearchRegExp,
  SEARCH_MAX_FILE_BYTES,
  type SearchFileResult,
  type SearchQuery,
} from '../../../electron/shared/workspace-search';

const LE_BOM = Buffer.from([0xff, 0xfe]);
const BE_BOM = Buffer.from([0xfe, 0xff]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16le = (s: string): Buffer => Buffer.from(s, 'utf16le');
const utf16be = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < b.length; i += 2) [b[i], b[i + 1]] = [b[i + 1]!, b[i]!];
  return b;
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-search-bom-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: Buffer | string): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const query = (pattern: string): SearchQuery => ({
  pattern,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
});

async function search(q: SearchQuery) {
  const files: SearchFileResult[] = [];
  const summary = await runTextSearch({ root, query: q, onFiles: (batch) => files.push(...batch) });
  const byRel = new Map(files.map((f) => [f.relPath, f]));
  return { summary, files, byRel, rel: [...byRel.keys()].sort() };
}

const TEXT = 'needle first\r\n  second 中文 needle\n';

describe('带 BOM 的 UTF-16 LE / BE 与 UTF-8 BOM 文件按 BOM 解码后搜', () => {
  it('三种都搜到;行 / 列(1 起,UTF-16,BOM 不计)/ 预览与 UTF-8 同一文本完全相同', async () => {
    write('plain.txt', TEXT);
    write('le.txt', Buffer.concat([LE_BOM, utf16le(TEXT)]));
    write('be.txt', Buffer.concat([BE_BOM, utf16be(TEXT)]));
    write('bom8.txt', Buffer.concat([UTF8_BOM, Buffer.from(TEXT, 'utf8')]));
    const { byRel, rel } = await search(query('needle'));
    expect(rel).toEqual(['be.txt', 'bom8.txt', 'le.txt', 'plain.txt']);
    const plain = byRel.get('plain.txt')!.matches;
    expect(plain.map((m) => [m.line, m.column])).toEqual([
      [1, 1],
      [2, 13],
    ]);
    for (const f of ['le.txt', 'be.txt', 'bom8.txt']) {
      expect(byRel.get(f)!.matches).toEqual(plain);
      expect(byRel.get(f)!.matches[0]!.preview.includes('﻿')).toBe(false);
    }
  });

  it('BOM 后紧跟的命中在第 1 列;只有 BOM 的空文件 / 无命中照常不出结果', async () => {
    write('le.txt', Buffer.concat([LE_BOM, utf16le('x')]));
    write('empty-le.txt', LE_BOM);
    write('empty8.txt', UTF8_BOM);
    const { byRel, rel } = await search(query('x'));
    expect(rel).toEqual(['le.txt']);
    expect(byRel.get('le.txt')!.matches[0]).toMatchObject({ line: 1, column: 1, length: 1, preview: 'x' });
  });

  it('无 BOM 的 GBK / UTF-16(不猜编码)、BOM 后字节不可逆(奇数字节的 UTF-16、非法 UTF-8)、解码出 NUL 的照旧跳过', async () => {
    write('ok.txt', 'needle');
    write('gbk.txt', iconv.encode('needle 中文', 'gbk'));
    write('le-nobom.txt', utf16le('needle'));
    write('le-odd.txt', Buffer.concat([LE_BOM, utf16le('needle'), Buffer.from([0x41])]));
    write('bom8-bad.txt', Buffer.concat([UTF8_BOM, Buffer.from('needle'), Buffer.from([0xff])]));
    write('le-nul.txt', Buffer.concat([LE_BOM, utf16le('needle\0bin')]));
    expect((await search(query('needle'))).rel).toEqual(['ok.txt']);
  });

  it('大小上限按磁盘字节:超过 1 MiB 的 UTF-16 文件计入「已跳过大文件」', async () => {
    write('big-le.txt', Buffer.concat([LE_BOM, utf16le(`needle${'x'.repeat(SEARCH_MAX_FILE_BYTES / 2)}`)]));
    const { summary, rel } = await search(query('needle'));
    expect(rel).toEqual([]);
    expect(summary.skippedLargePaths).toEqual([path.join(root, 'big-le.txt')]);
  });
});

describe('已打开编辑器覆盖磁盘结果(同一覆盖键)', () => {
  it('已打开的 UTF-16 文件(内容 = 解码后、不含 BOM)在内存里搜过 → 磁盘的同一文件结果丢弃;内存结果与磁盘结果行列一致', async () => {
    write('le.txt', Buffer.concat([LE_BOM, utf16le(TEXT)]));
    write('bom8.txt', Buffer.concat([UTF8_BOM, Buffer.from(TEXT, 'utf8')]));
    const q = query('needle');
    const { files } = await search(q);
    const docs = [
      { filePath: path.join(root, 'le.txt'), content: TEXT },
      { filePath: path.join(root, 'bom8.txt'), content: TEXT },
    ];
    const local = searchOpenEditors(docs, root, q, buildSearchRegExp(q));
    expect(local.files.map((f) => f.matches)).toEqual(
      ['le.txt', 'bom8.txt'].map((r) => files.find((f) => f.relPath === r)!.matches),
    );
    expect(mergeDiskBatch(files, local.searched, local.resultCount).files).toEqual([]);
  });
});
