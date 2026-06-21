// perf-audit P9 · fitAndResize 仅在网格(cols/rows)真变化时发 resize IPC。
// 侧栏拖拽/窗口 resize 多为像素级变化不改格子数,旧实现每次都无条件发 IPC→main→PTY。

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resizeSpy } = vi.hoisted(() => ({ resizeSpy: vi.fn() }));
vi.mock('@/lib/co-api', () => ({
  coApi: { terminal: { resize: resizeSpy } },
}));

// 只为拿到 fitAndResize;其它 import(xterm 等)在该模块顶层,vi.mock 兜底。
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn() }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }));
vi.mock('@continuo-terminal/react-terminal', () => ({}));

import { fitAndResize } from '../../panels/Terminal/useTerminal';

interface FakeTerm {
  cols: number;
  rows: number;
}

// fitAddon.fit() 模拟:把预设的 next 网格写进 term(真实 FitAddon 据容器算 cols/rows)。
function makeFit(term: FakeTerm, next: () => { cols: number; rows: number }) {
  return {
    fit: () => {
      const n = next();
      term.cols = n.cols;
      term.rows = n.rows;
    },
  };
}

describe('perf-audit P9 · fitAndResize resize-IPC 网格变化门控', () => {
  beforeEach(() => resizeSpy.mockClear());

  it('首次发一次;相同网格不再发;网格变化才再发', () => {
    const term: FakeTerm = { cols: 0, rows: 0 };
    const lastSize = { current: null as { cols: number; rows: number } | null };
    let grid = { cols: 80, rows: 24 };
    const fit = makeFit(term, () => grid);

    // 首次:80×24 → 发
    expect(
      fitAndResize(term as never, fit as never, 't1', lastSize),
    ).toBe(true);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 80, 24);

    // 像素级变化但 fit 后网格仍 80×24 → 不发
    fitAndResize(term as never, fit as never, 't1', lastSize);
    fitAndResize(term as never, fit as never, 't1', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(1);

    // 侧栏拖宽 → 网格变 100×24 → 发
    grid = { cols: 100, rows: 24 };
    fitAndResize(term as never, fit as never, 't1', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(2);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 100, 24);

    // 再次相同 100×24 → 不发
    fitAndResize(term as never, fit as never, 't1', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(2);

    // 行数变化(窗口变高)→ 发
    grid = { cols: 100, rows: 40 };
    fitAndResize(term as never, fit as never, 't1', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(3);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 100, 40);
  });

  it('网格无效(cols/rows=0,容器未布局)→ 不发,返回 false(供 RAF 重试)', () => {
    const term: FakeTerm = { cols: 0, rows: 0 };
    const lastSize = { current: null as { cols: number; rows: number } | null };
    const fit = makeFit(term, () => ({ cols: 0, rows: 0 }));
    expect(
      fitAndResize(term as never, fit as never, 't2', lastSize),
    ).toBe(false);
    expect(resizeSpy).not.toHaveBeenCalled();
  });
});
