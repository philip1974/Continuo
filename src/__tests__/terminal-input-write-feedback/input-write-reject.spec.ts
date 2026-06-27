// @vitest-environment jsdom
// a11y(A144,A141 同族):useTerminal 用户输入 term.onData → coApi.terminal.write 此前 fire-and-
// forget,既不判 ok:false 也无 catch。写入失败(PTY 已死 / IPC 异常)时用户键入「没反应」无
// 反馈。修复:write 加 .then(!ok→notify)+ .catch(notify),并 3s 限流避免每按键刷屏。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  onDataCbs: [] as Array<(data: string) => void>,
  write: vi.fn(),
  notifyError: vi.fn(),
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
      onData: vi.fn((cb: (data: string) => void) => {
        hoisted.onDataCbs.push(cb);
        return { dispose: vi.fn() };
      }),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      write: vi.fn(),
      dispose: vi.fn(),
    });
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
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: hoisted.write,
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
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

async function typeKey(data: string) {
  await act(async () => {
    for (const cb of hoisted.onDataCbs) cb(data);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  hoisted.onDataCbs.length = 0;
  hoisted.write.mockReset();
  hoisted.notifyError.mockReset();
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

describe('a11y(A144) · 终端输入 write 失败须反馈(限流)', () => {
  it('write {ok:false} → notify.error', async () => {
    hoisted.write.mockResolvedValue({ ok: false, code: 'EPIPE', message: 'dead' });
    render(createElement(Host, { termId: 't-w1' }));
    expect(hoisted.onDataCbs.length).toBeGreaterThan(0);
    await typeKey('a');
    expect(hoisted.notifyError).toHaveBeenCalledTimes(1);
  });

  it('write reject → notify.error', async () => {
    hoisted.write.mockRejectedValue(new Error('ipc down'));
    render(createElement(Host, { termId: 't-w2' }));
    await typeKey('b');
    expect(hoisted.notifyError).toHaveBeenCalledTimes(1);
  });

  it('write ok → 不弹 toast', async () => {
    hoisted.write.mockResolvedValue({ ok: true });
    render(createElement(Host, { termId: 't-w3' }));
    await typeKey('c');
    expect(hoisted.notifyError).not.toHaveBeenCalled();
  });

  it('连续多次失败按键 → 3s 限流只提示一次', async () => {
    hoisted.write.mockResolvedValue({ ok: false, code: 'EPIPE', message: 'dead' });
    render(createElement(Host, { termId: 't-w4' }));
    await typeKey('x');
    await typeKey('y');
    await typeKey('z');
    expect(hoisted.notifyError).toHaveBeenCalledTimes(1);
  });
});
