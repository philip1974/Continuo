import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { resizeSpy } = vi.hoisted(() => ({
  resizeSpy: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { terminal: { resize: resizeSpy } } }));
vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: vi.fn() }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }));
vi.mock('@continuo-terminal/react-terminal', () => ({}));

import { createResizeDebouncer } from '../../panels/Terminal/useTerminal';

function makeTerm(bufferLines: number) {
  const term = {
    cols: 80,
    rows: 24,
    buffer: { normal: { length: bufferLines } },
    resize: vi.fn((cols: number, rows: number) => {
      term.cols = cols;
      term.rows = rows;
    }),
  };
  return term;
}

function makeFit(term: ReturnType<typeof makeTerm>) {
  const fit = {
    container: { cols: 80, rows: 24 },
    proposeDimensions: () => ({ ...fit.container }),
    fit: vi.fn(() => {
      const d = fit.container;
      if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows);
    }),
  };
  return fit;
}

function setup(bufferLines: number) {
  const term = makeTerm(bufferLines);
  const fit = makeFit(term);
  const lastSize = { current: { cols: 80, rows: 24 } as { cols: number; rows: number } | null };
  const debouncer = createResizeDebouncer(term as never, fit as never, 't1', lastSize);
  return { term, fit, debouncer };
}

describe('terminal resize debounce · 长 buffer 列变化合并 reflow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resizeSpy.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('短 buffer(<200 行):立即 fit 并同步 PTY', () => {
    const { term, fit, debouncer } = setup(50);
    fit.container = { cols: 100, rows: 24 };
    debouncer.request();
    expect(term.cols).toBe(100);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 100, 24);
  });

  it('长 buffer:拖拽中连续列变化只在停下 100ms 后 reflow 一次(取最新尺寸)', () => {
    const { term, fit, debouncer } = setup(5000);
    for (const cols of [90, 100, 110]) {
      fit.container = { cols, rows: 24 };
      debouncer.request();
      vi.advanceTimersByTime(16);
    }
    expect(term.resize).not.toHaveBeenCalled();
    expect(resizeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(term.resize).toHaveBeenCalledTimes(1);
    expect(term.cols).toBe(110);
    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 110, 24);
  });

  it('长 buffer:行变化立即生效并同步 PTY', () => {
    const { term, fit, debouncer } = setup(5000);
    fit.container = { cols: 80, rows: 40 };
    debouncer.request();
    expect(term.rows).toBe(40);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 80, 40);
  });

  it('flush:立即按最新尺寸 fit,撤销未触发的防抖', () => {
    const { term, fit, debouncer } = setup(5000);
    fit.container = { cols: 120, rows: 24 };
    debouncer.request();
    debouncer.flush();
    expect(term.cols).toBe(120);
    expect(resizeSpy).toHaveBeenLastCalledWith('t1', 120, 24);
    vi.advanceTimersByTime(500);
    expect(term.resize).toHaveBeenCalledTimes(1);
  });

  it('dispose 撤销未触发的防抖', () => {
    const { term, fit, debouncer } = setup(5000);
    fit.container = { cols: 120, rows: 24 };
    debouncer.request();
    debouncer.dispose();
    vi.advanceTimersByTime(500);
    expect(term.resize).not.toHaveBeenCalled();
  });
});
