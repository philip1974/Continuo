// @vitest-environment jsdom
// topic 49 第十六轮 · P1-AR:readHistory replay 在 panel 卸载后不写已 dispose 的 xterm。
//
// 根因:useTerminal 的 `readHistory(termId).then(...)` 回调缺 teardown 守卫(同文件 onData /
// searchResults 回调都有 mountedRef 守卫,唯独这条 replay 漏了)。panel mount 后发起异步
// readHistory,在它 resolve 前 panel 被卸载(dockview lazy-mount inactive panel 快速关闭 /
// 切 workspace / StrictMode 双 mount / 慢盘),cleanup 已 disposeQueue(term)+term.dispose()。
// 之后迟到的 .then() 仍 safeWrite(term, ...);更糟:disposeQueue 删了 WeakMap 条目,迟到的
// safeWrite→getQueue 新建一个 disposed:false 队列绕过 safeWrite 自身的 disposed 守卫 →
// term.write() 写到已拆除的 core,报 "Object has been disposed"。
// 注意:mountedRef 不够 —— StrictMode 第二次 mount 会把它重置回 true,让第一次 mount 的迟到
// readHistory 误判仍挂载。故用 init 作用域的 teardownDone 标志,cleanup 时置位。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  terms: [] as Array<{ write: ReturnType<typeof vi.fn> }>,
  historyDeferred: null as null | {
    promise: Promise<unknown>;
    resolve: (v: unknown) => void;
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(
    this: Record<string, unknown>,
  ) {
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
      onExit: vi.fn(() => vi.fn()),
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
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

beforeEach(() => {
  hoisted.terms.length = 0;
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

describe('topic49 P1-AR · readHistory 卸载后不写已 dispose 的 xterm', () => {
  it('卸载后 readHistory resolve → 不调 term.write(无写已死 xterm)', async () => {
    const { unmount } = render(createElement(Host, { termId: 't-race' }));
    const term = hoisted.terms[0]!;
    expect(term).toBeTruthy();

    // 先卸载(cleanup 跑 disposeQueue + term.dispose + teardownDone=true)
    unmount();

    // 迟到的 readHistory 带非空 history resolve
    hoisted.historyDeferred!.resolve({ ok: true, data: { data: 'late-history' } });
    await hoisted.historyDeferred!.promise;
    await Promise.resolve();

    // 关键:teardown 守卫拦下,term.write 不被调用
    expect(term.write).not.toHaveBeenCalled();
  });

  it('未卸载时 readHistory resolve → 正常写入(回归)', async () => {
    render(createElement(Host, { termId: 't-ok' }));
    const term = hoisted.terms[0]!;

    hoisted.historyDeferred!.resolve({ ok: true, data: { data: 'hello-history' } });
    await hoisted.historyDeferred!.promise;
    await Promise.resolve();
    await Promise.resolve();

    expect(term.write).toHaveBeenCalled();
  });
});
