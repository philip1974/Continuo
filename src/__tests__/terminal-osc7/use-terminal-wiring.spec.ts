// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  registerMock: vi.fn(),
  capturedOnCwd: undefined as ((cwd: string) => void) | undefined,
  disposeMock: vi.fn(),
}));

vi.mock('@continuo-terminal/react-terminal', async (importActual) => {
  const actual = await importActual<typeof import('@continuo-terminal/react-terminal')>();
  hoisted.registerMock.mockImplementation((_term, onCwd, _opts) => {
    hoisted.capturedOnCwd = onCwd;
    return { dispose: hoisted.disposeMock };
  });
  return { ...actual, registerOsc7Cwd: hoisted.registerMock };
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
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })) }));
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
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/stores/layout-ui.store', () => ({
  useLayoutUiStore: (s: (state: { sidebarOpen: boolean; sidebarWidth: number }) => unknown) =>
    s({ sidebarOpen: true, sidebarWidth: 280 }),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { coApi } from '@/lib/co-api';
import { WebglAddon } from '@xterm/addon-webgl';

function Host({ termId }: { termId: string }) {
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

// 受控 rAF:捕获回调,手动 flush —— 验证 WebGL 延后到下一帧安装(Phase-5)。
let rafCbs: Array<FrameRequestCallback | null> = [];
function flushRaf(): void {
  const cbs = rafCbs.slice();
  rafCbs = [];
  for (const cb of cbs) if (cb) cb(0);
}

beforeEach(() => {
  hoisted.capturedOnCwd = undefined;
  hoisted.registerMock.mockClear();
  hoisted.disposeMock.mockClear();
  rafCbs = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback) => rafCbs.push(cb),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => {
      if (id >= 1 && id <= rafCbs.length) rafCbs[id - 1] = null;
    },
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

describe('terminal-osc7 wiring (T13)', () => {
  it('T13a: useTerminal calls registerOsc7Cwd once with structural term shape', () => {
    render(createElement(Host, { termId: 'term-osc7' }));

    expect(hoisted.registerMock).toHaveBeenCalledTimes(1);
    const firstCall = hoisted.registerMock.mock.calls[0]!;
    expect(firstCall[0]).toMatchObject({
      parser: expect.objectContaining({ registerOscHandler: expect.any(Function) }),
    });
    expect(firstCall[2]).toBeUndefined();
  });

  it('T13b: captured onCwd routes to coApi.terminal.updateCwd with termId', () => {
    render(createElement(Host, { termId: 'term-osc7' }));

    expect(hoisted.capturedOnCwd).toBeDefined();
    hoisted.capturedOnCwd!('/tmp');
    expect(coApi.terminal.updateCwd).toHaveBeenCalledTimes(1);
    expect(coApi.terminal.updateCwd).toHaveBeenCalledWith('term-osc7', '/tmp');
  });

  it('T13c: unmount triggers disposable.dispose once', () => {
    const { unmount } = render(createElement(Host, { termId: 'term-osc7' }));

    unmount();

    expect(hoisted.disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe('Phase-5 · WebGL 延后到下一帧(首屏接线不被 GPU init 阻塞)', () => {
  it('mount 时 WebGL 不同步创建 + stdout listener 已同步注册(可即时清 loading)', () => {
    render(createElement(Host, { termId: 'term-webgl' }));
    // WebGL 还没装(挪到 rAF);但 stdout onData 已同步订阅 → 首字节可立即清 loading
    expect(WebglAddon).not.toHaveBeenCalled();
    expect(coApi.terminal.onData).toHaveBeenCalledTimes(1);
    expect(coApi.terminal.readHistory).toHaveBeenCalledTimes(1);
  });

  it('flush 下一帧 → WebGL 安装', () => {
    render(createElement(Host, { termId: 'term-webgl' }));
    expect(WebglAddon).not.toHaveBeenCalled();
    flushRaf();
    expect(WebglAddon).toHaveBeenCalledTimes(1);
  });

  it('卸载先于下一帧 → WebGL 取消,不创建(不为已拆终端装 GPU)', () => {
    const { unmount } = render(createElement(Host, { termId: 'term-webgl' }));
    unmount();
    flushRaf();
    expect(WebglAddon).not.toHaveBeenCalled();
  });
});
