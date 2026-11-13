// @vitest-environment jsdom
// race(R84):search hotkey 的 queueMicrotask 此前用 hook 级 mountedRef 守卫,而非本次 xterm
// init 的 teardownDone。session 切换(termId 变 → 同一 hook re-init doInitXterm)或 StrictMode
// remount 同一 tick 内,旧 term 排队的微任务在新 term 已 mount 后才跑;mountedRef 此刻已被新
// init 置回 true → 旧微任务误把搜索框打开到新实例。改用 per-init teardownDone 守卫后旧微任务丢弃。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
}));

vi.mock('@continuo-terminal/react-terminal', async (importActual) => {
  const actual = await importActual<typeof import('@continuo-terminal/react-terminal')>();
  return { ...actual, registerOsc7Cwd: vi.fn(() => ({ dispose: vi.fn() })) };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(
    this: Record<string, unknown>,
    options: Record<string, unknown>,
  ) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      // R84:捕获最近一次注册的 custom key handler。
      attachCustomKeyEventHandler: vi.fn((h: (e: KeyboardEvent) => boolean) => {
        hoisted.keyHandler = h;
      }),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
// 搜索 addon 桩:真实 SearchAddon 未 loadAddon 到真 Terminal 时 findNext 会抛,挡住 dispatch 路径。
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
    clearActiveDecoration: vi.fn(),
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
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/stores/layout-ui.store', () => ({
  useLayoutUiStore: (
    s: (state: { sidebarOpen: boolean; sidebarWidth: number }) => unknown,
  ) => s({ sidebarOpen: true, sidebarWidth: 280 }),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';

let latestSearchApi: ReturnType<typeof useTerminal>['searchApi'] | undefined;

function Host({ termId }: { termId: string }) {
  const { containerRef, searchApi } = useTerminal(termId);
  latestSearchApi = searchApi;
  return createElement('div', {
    ref: containerRef,
    'data-search-open': String(searchApi.isOpen),
  });
}

beforeEach(() => {
  hoisted.keyHandler = undefined;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback) => {
      void cb;
      return 1;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });
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

function searchHotkeyEvent(): KeyboardEvent {
  // 非 mac(jsdom navigator.platform='')→ Ctrl+F;无 alt/shift/meta。
  return {
    type: 'keydown',
    key: 'f',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  } as unknown as KeyboardEvent;
}

describe('race(R84) · search hotkey 微任务用 per-init teardownDone 守卫', () => {
  it('termId 变化 re-init 后,旧 term 排队的搜索微任务不打开新实例搜索框', async () => {
    const { container, rerender } = render(createElement(Host, { termId: 'term-a' }));
    expect(hoisted.keyHandler).toBeDefined();
    const h1 = hoisted.keyHandler!; // term-a(init#1)的 key handler

    // 劫持 queueMicrotask 捕获回调(不调度),以便在 re-init 之后再手动执行 —— 确定性复现
    // 「微任务在旧 term cleanup + 新 term mount 之后才跑」的关键时序(否则微任务会先于
    // cleanup 跑,teardownDone 还 false,新旧行为都开搜索且此时开在 term-a 上是正确的)。
    const realQM = globalThis.queueMicrotask;
    let captured: (() => void) | undefined;
    globalThis.queueMicrotask = (cb: () => void) => {
      captured = cb;
    };
    try {
      const handled = h1(searchHotkeyEvent()); // 在 term-a 按搜索热键 → 捕获微任务(闭包 init#1 teardownDone)
      expect(handled).toBe(false);
    } finally {
      globalThis.queueMicrotask = realQM;
    }
    expect(captured).toBeDefined();

    // session 切换:termId 变 → 同一 hook re-init(cleanup#1 置 teardownDone#1=true + init#2 新 term,
    // mountedRef 又被置回 true)。effect flush 完毕后再跑被捕获的旧微任务。
    await act(async () => {
      rerender(createElement(Host, { termId: 'term-b' }));
    });

    // 在 re-init 之后执行旧 init#1 排队的微任务:应因 teardownDone#1=true 被丢弃(用 mountedRef
    // 则因已被新 init 置回 true 而误开搜索)。
    act(() => {
      captured!();
    });

    const div = container.querySelector('div[data-search-open]');
    expect(div?.getAttribute('data-search-open')).toBe('false');
  });
});

// 第二轮审计:xterm 内按搜索热键的分支此前直接 setSearchState(reducer(open)),绕过 dispatchSearchAction
// —— 不更新 searchStateRef。之后任何一次 dispatch(输入搜索词 / 改选项)都以 ref(仍是「关闭」)为基底
// 算 next 并整体写回 state → 刚打开的搜索条被关掉。平时被 terminal.search.toggle 命令的并行路径掩盖,
// 用户改绑该命令后暴露。热键分支必须走同一入口。
describe('xterm 内搜索热键走 dispatchSearchAction(ref 与 state 同步)', () => {
  it('热键打开后再输入搜索词 → 搜索条保持打开', async () => {
    const { container } = render(createElement(Host, { termId: 'term-a' }));
    const host = container.firstElementChild as HTMLElement;
    expect(hoisted.keyHandler).toBeDefined();

    await act(async () => {
      hoisted.keyHandler!(searchHotkeyEvent());
      await Promise.resolve();
    });
    expect(host.getAttribute('data-search-open')).toBe('true');

    await act(async () => {
      latestSearchApi!.setTerm('needle');
    });
    expect(host.getAttribute('data-search-open')).toBe('true');
  });
});
