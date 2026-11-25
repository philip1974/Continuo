// @vitest-environment jsdom
// 性能 P1 接线:useTerminal 的实时输出经写入合并再进 safeWrite(见 README「写入合并」)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  writes: [] as string[],
  onDataHandler: null as null | ((data: string, offset?: number) => void),
  historyDeferred: null as null | {
    promise: Promise<unknown>;
    resolve: (v: unknown) => void;
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options: {},
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      write: vi.fn((d: string) => hoisted.writes.push(d)),
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn().mockResolvedValue({ ok: true }),
      updateCwd: vi.fn().mockResolvedValue({ ok: true }),
      onData: vi.fn((_id: string, cb: (data: string, offset?: number) => void) => {
        hoisted.onDataHandler = cb;
        return vi.fn();
      }),
      readHistory: vi.fn(() => hoisted.historyDeferred!.promise),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { OUTPUT_COALESCE_WINDOW_MS } from '../../panels/Terminal/output-coalescer';

function Host({ termId }: { termId: string }) {
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

const live = (data: string, offset?: number) => hoisted.onDataHandler!(data, offset);
const waitWindow = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, OUTPUT_COALESCE_WINDOW_MS * 3));
  });

beforeEach(() => {
  hoisted.writes.length = 0;
  hoisted.onDataHandler = null;
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  hoisted.historyDeferred = { promise, resolve };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe() {}
      disconnect() {}
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mountReady(termId: string) {
  const r = render(createElement(Host, { termId }));
  await act(async () => {
    hoisted.historyDeferred!.resolve({ ok: true, data: { data: '', truncated: false } });
    await Promise.resolve();
  });
  return r;
}

describe('useTerminal · 实时输出写入合并', () => {
  it('连续多条小块 → 合并为少量 term.write,内容与顺序不变', async () => {
    await mountReady('t-coalesce');
    const parts = Array.from({ length: 30 }, (_, i) => `row ${i}\r\n`);
    act(() => {
      for (const p of parts) live(p);
    });
    await waitWindow();
    expect(hoisted.writes.join('')).toBe(parts.join(''));
    // 空闲后前两块立即写(首块 + 紧随一块,保同屏重绘同帧),其余合并为一次
    expect(hoisted.writes.length).toBeLessThanOrEqual(3);
  });

  it('首块立即写出(无首字节延迟)', async () => {
    await mountReady('t-first');
    act(() => live('$ '));
    expect(hoisted.writes).toEqual(['$ ']);
  });

  it('卸载时合并缓冲里未写出的输出被丢弃,窗口到期后也不再写已 dispose 的 xterm', async () => {
    const { unmount } = await mountReady('t-unmount');
    act(() => {
      live('a');
      live('L');
      live('pending');
    });
    expect(hoisted.writes).toEqual(['a', 'L']);
    unmount();
    await waitWindow();
    expect(hoisted.writes).toEqual(['a', 'L']);
  });
});
