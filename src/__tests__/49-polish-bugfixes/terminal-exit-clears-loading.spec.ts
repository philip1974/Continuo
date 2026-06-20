// @vitest-environment jsdom
// P2 未闭环回归(第八 session R3):TerminalPanelView 的「Starting shell…」spinner 由
// useTerminal 的 isReady 门控,而 isReady 此前只有两条 set-true 入口 —— 首个 onData chunk
// 或非空 readHistory。useTerminal **完全不订阅 terminal:exit**。若某 PTY 在产出任何字节
// 之前就退出(自定义 shell 立即失败 / 零输出即 exit / 启动后立刻被 kill),firstData 恒真、
// isReady 恒假 → spinner 永久悬浮在一个已死终端上,挡住真实状态(典型「状态机标记建了未
// 覆盖所有终态」族)。main 端 cleanupSessionLocal 已发 terminal:exit,但 renderer 无消费方。
//
// 修复:useTerminal 订阅 coApi.terminal.onExit,本 termId 退出时清 isReady(移掉 overlay,
// 让退出前缓冲/错误输出可见)。带 teardownDone 守卫 + termId 过滤 + cleanup 解绑。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  terms: [] as Array<{ write: ReturnType<typeof vi.fn> }>,
  historyDeferred: null as null | { promise: Promise<unknown>; resolve: (v: unknown) => void },
  exitCbs: [] as Array<(id: string, payload: unknown) => void>,
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
      onExit: vi.fn((cb: (id: string, payload: unknown) => void) => {
        hoisted.exitCbs.push(cb);
        return vi.fn();
      }),
      readHistory: vi.fn(() => hoisted.historyDeferred!.promise),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
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
  hoisted.exitCbs.length = 0;
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
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

describe('49 第八 session · terminal exit 清 loading overlay', () => {
  it('PTY 零输出即退出 → onExit 清 isReady(spinner 不再永挂)', async () => {
    const { container } = render(createElement(Host, { termId: 't-exit' }));
    const div = container.querySelector('div')!;
    // 无 onData、history 未 resolve → 仍 loading
    expect(div.getAttribute('data-ready')).toBe('false');
    expect(hoisted.exitCbs.length).toBeGreaterThan(0);

    await act(async () => {
      for (const cb of hoisted.exitCbs) cb('t-exit', { exitCode: 1 });
    });
    expect(div.getAttribute('data-ready')).toBe('true');
  });

  it('其它 termId 的 exit 不误清本终端 loading', async () => {
    const { container } = render(createElement(Host, { termId: 't-mine' }));
    const div = container.querySelector('div')!;
    await act(async () => {
      for (const cb of hoisted.exitCbs) cb('t-other', { exitCode: 0 });
    });
    expect(div.getAttribute('data-ready')).toBe('false');
  });
});
