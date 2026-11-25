// BDD: terminal-file-links / 4 xterm link provider:只为存在的文件出链接、范围映射回单元格(软换行 / 宽字符)、解析缓存、激活
import { describe, expect, it, vi } from 'vitest';
import type { ILink, Terminal } from '@xterm/xterm';
import {
  RESOLVE_CACHE_TTL_MS,
  createTerminalFileLinkProvider,
  type TerminalFileLinkDeps,
} from '@/panels/Terminal/terminal-file-links';

interface FakeCell {
  readonly chars: string;
  readonly width: number;
}

/** 按列数切成缓冲行(超出列数软换行;CJK 占两格,后半格 width 0)。 */
function fakeTerm(lines: readonly string[], cols = 20): Terminal {
  const rows: Array<{ cells: FakeCell[]; isWrapped: boolean }> = [];
  for (const text of lines) {
    let cur: FakeCell[] = [];
    let first = true;
    const push = () => {
      rows.push({ cells: cur, isWrapped: !first });
      first = false;
      cur = [];
    };
    for (const ch of text) {
      const wide = /[一-鿿]/.test(ch);
      if (cur.length + (wide ? 2 : 1) > cols) push();
      cur.push({ chars: ch, width: wide ? 2 : 1 });
      if (wide) cur.push({ chars: '', width: 0 });
    }
    push();
  }
  const buffer = {
    length: rows.length,
    getLine: (y: number) => {
      const row = rows[y];
      if (!row) return undefined;
      return {
        isWrapped: row.isWrapped,
        length: cols,
        getCell: (x: number) => {
          const c = row.cells[x] ?? { chars: '', width: 1 };
          return { getChars: () => c.chars, getWidth: () => c.width };
        },
      };
    },
  };
  return { buffer: { active: buffer } } as unknown as Terminal;
}

function provide(term: Terminal, deps: TerminalFileLinkDeps, y: number): Promise<ILink[] | undefined> {
  const provider = createTerminalFileLinkProvider(term, deps);
  return new Promise((resolve) => provider.provideLinks(y, resolve));
}

function deps(over: Partial<TerminalFileLinkDeps> = {}): TerminalFileLinkDeps & { resolve: ReturnType<typeof vi.fn> } {
  return {
    getCwd: () => '/w',
    resolve: vi.fn(async (paths: readonly string[]) => paths.map((p) => (p.startsWith('nope') ? null : `/w/${p}`))),
    open: vi.fn(),
    ...over,
  } as TerminalFileLinkDeps & { resolve: ReturnType<typeof vi.fn> };
}

describe('provideLinks', () => {
  it('只为解析存在的路径出链接;范围覆盖路径 + 行列后缀(1 起、末格含)', async () => {
    const d = deps();
    const links = await provide(fakeTerm(['x src/a.ts:2:5 nope.ts', 'next']), d, 1);
    expect(d.resolve).toHaveBeenCalledWith(['src/a.ts', 'nope.ts']);
    expect(links?.map((l) => [l.text, l.range])).toEqual([
      ['src/a.ts:2:5', { start: { x: 3, y: 1 }, end: { x: 14, y: 1 } }],
    ]);
  });
  it('行内没有候选 / 全都不存在 → undefined', async () => {
    expect(await provide(fakeTerm(['hello 1999']), deps(), 1)).toBeUndefined();
    expect(await provide(fakeTerm(['nope.ts']), deps(), 1)).toBeUndefined();
  });
  it('软换行的长路径按逻辑行识别,悬停任一物理行都得到整条链接', async () => {
    const term = fakeTerm(['ab src/very/long/path/file.ts:12'], 10);
    const second = await provide(term, deps(), 2);
    const third = await provide(term, deps(), 3);
    const expected = { start: { x: 4, y: 1 }, end: { x: 2, y: 4 } };
    expect(second?.[0]?.range).toEqual(expected);
    expect(third?.[0]?.range).toEqual(expected);
    expect(second?.[0]?.text).toBe('src/very/long/path/file.ts:12');
  });
  it('宽字符前缀:单元格列按显示宽度映射', async () => {
    const links = await provide(fakeTerm(['错误 a.ts:1']), deps(), 1);
    // 「错误」占 4 格 + 空格 → a.ts 从第 6 格开始
    expect(links?.[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 11, y: 1 } });
  });
  it('解析失败(IPC 出错)→ 不出链接', async () => {
    const d = deps({ resolve: vi.fn(async () => null) });
    expect(await provide(fakeTerm(['src/a.ts']), d, 1)).toBeUndefined();
  });
});

describe('解析缓存', () => {
  it('同 cwd 同路径 10s 内不重复 IPC;过期 / cwd 变化 / 上次失败 → 重新解析', async () => {
    let now = 0;
    let cwd = '/w';
    const resolve = vi.fn(async (paths: readonly string[]) => paths.map((p) => `/w/${p}`));
    const d = deps({ resolve, getCwd: () => cwd, now: () => now });
    const provider = createTerminalFileLinkProvider(fakeTerm(['src/a.ts lib/b.ts']), d);
    const ask = () => new Promise<ILink[] | undefined>((r) => provider.provideLinks(1, r));
    await ask();
    await ask();
    expect(resolve).toHaveBeenCalledTimes(1);
    now = RESOLVE_CACHE_TTL_MS;
    await ask();
    expect(resolve).toHaveBeenCalledTimes(2);
    cwd = '/w/src';
    await ask();
    expect(resolve).toHaveBeenCalledTimes(3);
    resolve.mockRejectedValueOnce(new Error('ipc'));
    cwd = '/other';
    expect(await ask()).toBeUndefined();
    expect(await ask()).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(5);
  });
});

describe('激活', () => {
  it('activate 把绝对路径与行列交给 open(修饰键判定在 open 内)', async () => {
    const d = deps();
    const links = await provide(fakeTerm(['./file-2.ts(1,3)']), d, 1);
    const event = { metaKey: true } as MouseEvent;
    links![0]!.activate(event, links![0]!.text);
    expect(d.open).toHaveBeenCalledWith('/w/./file-2.ts', 1, 3, event);
  });
});
