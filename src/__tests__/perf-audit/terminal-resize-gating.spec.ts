// perf-audit P9 · fitAndResize 仅在网格(cols/rows)真变化时发 resize IPC。
// 侧栏拖拽/窗口 resize 多为像素级变化不改格子数,旧实现每次都无条件发 IPC→main→PTY。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// race(R96):coApi.terminal.resize 现返回 Promise<IpcResult>(fitAndResize 失败回滚需 .then);
// mock 须返回 resolved promise,否则 .then on undefined 抛错。
const { resizeSpy } = vi.hoisted(() => ({
  resizeSpy: vi.fn(async () => ({ ok: true as const })),
}));
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

  // race(R96):lastSize 乐观更新阻止在途重复 resize,但 resize IPC 失败(ok:false/reject)必须回滚,
  // 否则 lastSize 谎称已同步 → 同网格不重试 → xterm DOM 与 PTY 尺寸长期不一致。
  it('R96 resize IPC ok:false → lastSize 回滚,同网格重试再发', async () => {
    resizeSpy.mockReset();
    resizeSpy
      .mockResolvedValueOnce({ ok: false }) // 第一次 PTY resize 失败
      .mockResolvedValue({ ok: true });
    const term: FakeTerm = { cols: 0, rows: 0 };
    const lastSize = { current: null as { cols: number; rows: number } | null };
    const fit = makeFit(term, () => ({ cols: 80, rows: 24 }));

    fitAndResize(term as never, fit as never, 't1', lastSize); // 发 #1(80×24),乐观置 lastSize
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve(); // 让 .then 跑:ok:false → 回滚 lastSize

    // 同网格再 fit:lastSize 已回滚 → 重试再发(此前会被去重永久跳过)。
    fitAndResize(term as never, fit as never, 't1', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(2);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 80, 24);
  });

  // race(R47):lastSentSizeRef 跨 session 持久。切 session 时若不重置,新 session 首次 fit 算出
  // 与上个 session 相同的网格会被去重跳过 → 新 PTY 停默认 80×24。useTerminal 的 [termId] effect
  // 在切 session 时 `lastSentSizeRef.current = null` 以保证每个新 session 至少发一次初始 resize。
  // 本测试在 fitAndResize 层复现:同尺寸不重置=漏发(bug);重置 null=补发(fix 语义)。
  it('R47 切 session 同网格:不重置漏发初始 resize;重置 null 则补发', () => {
    const term: FakeTerm = { cols: 0, rows: 0 };
    const lastSize = { current: null as { cols: number; rows: number } | null };
    const fit = makeFit(term, () => ({ cols: 80, rows: 24 }));

    // session A 首次:80×24 → 发(termId 't-A')
    fitAndResize(term as never, fit as never, 't-A', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenLastCalledWith('t-A', 80, 24);

    // 切到 session B(同一 hook 复用,lastSize 未重置),容器尺寸不变 → 网格仍 80×24。
    // bug:去重命中 → 新 PTY 't-B' 收不到初始 resize。
    resizeSpy.mockClear();
    fitAndResize(term as never, fit as never, 't-B', lastSize);
    expect(resizeSpy).not.toHaveBeenCalled(); // 漏发(正是 R47 的故障表现)

    // fix:[termId] effect 切 session 时重置 lastSize.current = null → 新 session 必发初始 resize。
    lastSize.current = null;
    fitAndResize(term as never, fit as never, 't-B', lastSize);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenLastCalledWith('t-B', 80, 24);
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
