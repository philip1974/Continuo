// @vitest-environment jsdom
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
import { useTerminalStore } from '../../stores/terminal.store';

function Host({ termId }: { termId: string }) {
  const { containerRef, isReady } = useTerminal(termId);
  return createElement('div', { ref: containerRef, 'data-ready': String(isReady) });
}

const resolveHistory = async (v: unknown) => {
  await act(async () => {
    hoisted.historyDeferred!.resolve(v);
    await Promise.resolve();
  });
};

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
  useTerminalStore.setState({ sessions: [] });
  vi.clearAllMocks();
});

const session = (id: string, exitCode: number | null) => ({
  id,
  title: id,
  cwd: '/tmp',
  originHint: 'agent' as const,
  createdAt: 0,
  exitCode,
  ownerWindowId: 1,
});
const ready = (c: HTMLElement) => c.querySelector('div')!.getAttribute('data-ready');

describe('terminal exited history · 渲染端空历史不永挂 loading', () => {
  it('会话已退出 + 空历史 → 清 loading', async () => {
    useTerminalStore.setState({ sessions: [session('t-exited', 0)] });
    const { container } = render(createElement(Host, { termId: 't-exited' }));
    await resolveHistory({ ok: true, data: { data: '', truncated: false } });
    expect(ready(container)).toBe('true');
  });

  it('会话仍在运行 + 空历史 → 保留 loading 等首批输出', async () => {
    useTerminalStore.setState({ sessions: [session('t-live', null)] });
    const { container } = render(createElement(Host, { termId: 't-live' }));
    await resolveHistory({ ok: true, data: { data: '', truncated: false, endOffset: 0 } });
    expect(ready(container)).toBe('false');
  });
});
