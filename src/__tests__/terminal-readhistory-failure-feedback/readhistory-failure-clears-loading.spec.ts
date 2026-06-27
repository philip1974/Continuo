// @vitest-environment jsdom
// a11y(A143,A141 同族 + 第八 session exit-clears 同族「isReady 终态覆盖」):useTerminal 的
// readHistory().then 此前在 !r.ok 时只 return、且全无 .catch。lazy-mount 终端的初始输出
// (prompt)在 PTY spawn 后、panel mount 前产出,只存在于 history —— history 读失败(reject
// 或 !ok)则 onData 不会补发,firstData 恒真 →「Starting shell…」spinner 永久悬浮 + 无反馈。
// 修复:失败分支也清 isReady(移 overlay)并 notify.error。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  terms: [] as Array<{ write: ReturnType<typeof vi.fn> }>,
  historyDeferred: null as null | {
    promise: Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  },
  notifyError: vi.fn(),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>) {
    const write = vi.fn();
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options: {},
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      write,
      dispose: vi.fn(),
    });
    hoisted.terms.push(this as unknown as { write: ReturnType<typeof vi.fn> });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
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
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      readHistory: vi.fn(() => hoisted.historyDeferred!.promise),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: hoisted.notifyError } }));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/stores/layout-ui.store', () => ({
  useLayoutUiStore: (s: (st: { sidebarOpen: boolean; sidebarWidth: number }) => unknown) =>
    s({ sidebarOpen: true, sidebarWidth: 280 }),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';

function Host({ termId }: { termId: string }) {
  const { containerRef, isReady } = useTerminal(termId);
  return createElement('div', { ref: containerRef, 'data-ready': String(isReady) });
}

beforeEach(() => {
  hoisted.terms.length = 0;
  hoisted.notifyError.mockReset();
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  hoisted.historyDeferred = { promise, resolve, reject };
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

describe('a11y(A143) · readHistory 失败清 loading overlay + 反馈', () => {
  it('readHistory {ok:false} → 清 isReady + notify.error(spinner 不再永挂)', async () => {
    const { container } = render(createElement(Host, { termId: 't-hist-fail' }));
    const div = container.querySelector('div')!;
    expect(div.getAttribute('data-ready')).toBe('false');

    await act(async () => {
      hoisted.historyDeferred!.resolve({ ok: false, code: 'EIO', message: 'read fail' });
      await Promise.resolve();
    });
    expect(div.getAttribute('data-ready')).toBe('true');
    expect(hoisted.notifyError).toHaveBeenCalledTimes(1);
  });

  it('readHistory reject → 清 isReady + notify.error', async () => {
    const { container } = render(createElement(Host, { termId: 't-hist-reject' }));
    const div = container.querySelector('div')!;
    expect(div.getAttribute('data-ready')).toBe('false');

    await act(async () => {
      hoisted.historyDeferred!.reject(new Error('ipc down'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(div.getAttribute('data-ready')).toBe('true');
    expect(hoisted.notifyError).toHaveBeenCalledTimes(1);
  });

  it('readHistory ok 但空数据 → 留 loading 给 onData(不误清不误报)', async () => {
    const { container } = render(createElement(Host, { termId: 't-hist-empty' }));
    const div = container.querySelector('div')!;

    await act(async () => {
      hoisted.historyDeferred!.resolve({ ok: true, data: { data: '' } });
      await Promise.resolve();
    });
    expect(div.getAttribute('data-ready')).toBe('false');
    expect(hoisted.notifyError).not.toHaveBeenCalled();
  });
});
