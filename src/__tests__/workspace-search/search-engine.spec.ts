// BDD: workspace-search / 4 搜索引擎(worker 内运行;这里直接调用):排除规则、跳过的文件、行列与预览、限额、分批
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTextSearch, type TextSearchOptions } from '../../../electron/main/search/text-search';
import { searchOpenEditors } from '../../panels/Search/open-editor-search';
import {
  buildSearchRegExp,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_RESULTS_PER_FILE,
  SEARCH_PREVIEW_LEAD,
  SEARCH_PREVIEW_MAX,
  type SearchFileResult,
  type SearchQuery,
} from '../../../electron/shared/workspace-search';
import { WORKSPACE_SCAN_EXCLUDE } from '../../../electron/shared/fs-limits';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-search-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const query = (pattern: string, o: Partial<SearchQuery> = {}): SearchQuery => ({
  pattern,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  ...o,
});

async function search(q: SearchQuery, extra: Partial<TextSearchOptions> = {}) {
  const batches: SearchFileResult[][] = [];
  const summary = await runTextSearch({ root, query: q, onFiles: (files) => batches.push([...files]), ...extra });
  const files = batches.flat();
  return { summary, batches, files, rel: files.map((f) => f.relPath).sort() };
}

describe('排除规则与跳过的文件', () => {
  it('与 Quick Open 同一排除表:.git / node_modules / dist / out / build 等不搜', async () => {
    expect(WORKSPACE_SCAN_EXCLUDE).toEqual(expect.arrayContaining(['.git', 'node_modules', 'dist', 'out', 'build', '.next']));
    write('src/a.ts', 'needle');
    for (const dir of ['.git', 'node_modules/pkg', 'dist', 'out', 'build', '.next']) write(`${dir}/x.ts`, 'needle');
    expect((await search(query('needle'))).rel).toEqual(['src/a.ts']);
  });

  it('二进制(含 NUL)、非 UTF-8、超过 1 MiB 的文件跳过', async () => {
    write('ok.txt', 'needle');
    write('bin.dat', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    write('latin1.txt', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xe9, 0xff]));
    write('big.txt', `needle\n${'x'.repeat(SEARCH_MAX_FILE_BYTES)}`);
    expect((await search(query('needle'))).rel).toEqual(['ok.txt']);
  });

  it('因超过 1 MiB 跳过的文件计数并报告路径(其它原因的跳过不计;renderer 据此提示「已跳过 N 个大文件」)', async () => {
    write('ok.txt', 'needle');
    write('bin.dat', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    write('big.txt', `needle\n${'x'.repeat(SEARCH_MAX_FILE_BYTES)}`);
    write('sub/big.log', 'y'.repeat(SEARCH_MAX_FILE_BYTES + 1));
    write('sub/excluded.big', 'y'.repeat(SEARCH_MAX_FILE_BYTES + 1));
    const { summary } = await search(query('needle', { exclude: '*.big' }));
    expect(summary.skippedLargeCount).toBe(2);
    expect([...summary.skippedLargePaths].sort()).toEqual([path.join(root, 'big.txt'), path.join(root, 'sub/big.log')].sort());
  });

  it.skipIf(process.platform === 'win32')('符号链接与 FIFO 不搜(不跟随链接、不读非普通文件)', async () => {
    write('real/a.txt', 'needle');
    const outside = mkdtempSync(path.join(tmpdir(), 'ws-search-out-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'needle');
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
      symlinkSync(outside, path.join(root, 'linkdir'));
      execFileSync('mkfifo', [path.join(root, 'pipe')]);
      expect((await search(query('needle'))).rel).toEqual(['real/a.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('包含 / 排除的文件按相对路径过滤', async () => {
    write('src/a.ts', 'needle');
    write('src/a.test.ts', 'needle');
    write('docs/a.md', 'needle');
    expect((await search(query('needle', { include: 'src' }))).rel).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect((await search(query('needle', { include: 'src', exclude: '*.test.ts' }))).rel).toEqual(['src/a.ts']);
    expect((await search(query('needle', { exclude: './docs' }))).rel).toEqual(['src/a.test.ts', 'src/a.ts']);
  });
});

describe('命中:行列与预览', () => {
  it('逐个命中一条结果;行 / 列 1 起(UTF-16);\\r\\n 不进预览', async () => {
    write('a.txt', 'first\r\n  foo bar foo\r\nFOO\n');
    const { files } = await search(query('foo'));
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(path.join(root, 'a.txt'));
    expect(files[0]!.matches.map((m) => [m.line, m.column, m.length])).toEqual([
      [2, 3, 3],
      [2, 11, 3],
      [3, 1, 3],
    ]);
    // 预览去行首空白,命中位置随之平移
    const m0 = files[0]!.matches[0]!;
    expect(m0.preview).toBe('foo bar foo');
    expect(m0.preview.slice(m0.previewStart, m0.previewStart + m0.previewLength)).toBe('foo');
    expect(files[0]!.matches[1]!.previewStart).toBe(8);
  });

  it('区分大小写 / 全词 / 正则', async () => {
    write('a.txt', 'Foo foo food\nab12 abc\n');
    const count = async (q: SearchQuery) => (await search(q)).files.flatMap((f) => f.matches).length;
    expect(await count(query('foo'))).toBe(3);
    expect(await count(query('foo', { matchCase: true }))).toBe(2);
    expect(await count(query('foo', { wholeWord: true }))).toBe(2);
    expect(await count(query('ab\\d+', { isRegex: true }))).toBe(1);
  });

  it('零长度命中跳过(如 ^、a*)', async () => {
    write('a.txt', 'xyz\naa\n');
    expect((await search(query('^', { isRegex: true }))).files).toEqual([]);
    expect((await search(query('a*', { isRegex: true }))).files.flatMap((f) => f.matches).map((m) => m.line)).toEqual([2]);
  });

  it('命中前过长截掉并加「…」;预览封顶', async () => {
    const lead = 'x'.repeat(100);
    write('a.txt', `${lead}needle${'y'.repeat(1000)}`);
    const m = (await search(query('needle'))).files[0]!.matches[0]!;
    expect(m.column).toBe(101);
    expect(m.preview.startsWith('…')).toBe(true);
    expect(m.preview.slice(m.previewStart, m.previewStart + m.previewLength)).toBe('needle');
    expect(m.previewStart).toBe(SEARCH_PREVIEW_LEAD + 1);
    expect(m.preview.length).toBeLessThanOrEqual(SEARCH_PREVIEW_MAX + 1);
  });
});

describe('限额与分批', () => {
  it('每文件最多 1000 条(truncated);总计最多 10000 条(limitHit,停止)', async () => {
    const lines = `${'hit\n'.repeat(SEARCH_MAX_RESULTS_PER_FILE + 5)}`;
    const fileCount = SEARCH_MAX_RESULTS / SEARCH_MAX_RESULTS_PER_FILE + 2;
    for (let i = 0; i < fileCount; i += 1) write(`f${String(i).padStart(2, '0')}.txt`, lines);
    const { summary, files } = await search(query('hit'));
    expect(files.every((f) => f.matches.length <= SEARCH_MAX_RESULTS_PER_FILE)).toBe(true);
    expect(files[0]!.truncated).toBe(true);
    expect(files.flatMap((f) => f.matches)).toHaveLength(SEARCH_MAX_RESULTS);
    expect(summary).toEqual({ limitHit: true, filesLimitHit: false, skippedLargeCount: 0, skippedLargePaths: [] });
  });

  it('文件数上限:只搜前 N 个文件并标记 filesLimitHit', async () => {
    for (let i = 0; i < 5; i += 1) write(`f${i}.txt`, 'hit');
    const { summary, files } = await search(query('hit'), { maxFiles: 3 });
    expect(files).toHaveLength(3);
    expect(summary).toEqual({ limitHit: false, filesLimitHit: true, skippedLargeCount: 0, skippedLargePaths: [] });
  });

  it('分批推送:时间窗内攒批,结果按枚举顺序稳定', async () => {
    for (let i = 0; i < 30; i += 1) write(`d/f${String(i).padStart(2, '0')}.txt`, 'hit');
    let t = 0;
    const { batches, files } = await search(query('hit'), {
      // 每读一个文件时钟走 10ms → 50ms 窗口约 5 个文件一批
      now: () => (t += 10),
    });
    expect(batches.length).toBeGreaterThan(2);
    expect(files.map((f) => f.relPath)).toEqual(files.map((f) => f.relPath).slice().sort());
    expect(files).toHaveLength(30);
  });

  it('无命中:不推送空批,正常结束', async () => {
    write('a.txt', 'nothing');
    const { batches, summary } = await search(query('needle'));
    expect(batches).toEqual([]);
    expect(summary).toEqual({ limitHit: false, filesLimitHit: false, skippedLargeCount: 0, skippedLargePaths: [] });
  });
});

// BDD 7:renderer 在已打开编辑器的内存内容上搜,须与 worker 同一口径(同一 matchSearchText)。
describe('已打开编辑器的内存搜索与磁盘搜索同口径', () => {
  it('同一内容、各种查询选项下,内存结果与 main 引擎结果逐条一致', async () => {
    const content = '  😀 Foo foo foobar\r\n\tlet x = foo(1) // FOO\n' + `${'a'.repeat(80)}foo${'b'.repeat(300)}\nfoo\n`;
    write('a.ts', content);
    const queries = [
      query('foo'),
      query('foo', { matchCase: true }),
      query('foo', { wholeWord: true }),
      query('fo+\\b', { isRegex: true }),
      query('^\\s*', { isRegex: true }),
    ];
    for (const q of queries) {
      const disk = (await search(q)).files;
      const mem = searchOpenEditors([{ filePath: path.join(root, 'a.ts'), content }], root, q, buildSearchRegExp(q)).files;
      expect(mem.map((f) => f.matches)).toEqual(disk.map((f) => f.matches));
    }
  });
});
