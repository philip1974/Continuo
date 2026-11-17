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
    system: { windowId: 1, hostname: 'my-mac.local' },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import {
  CWD_REPORT_DEBOUNCE_MS,
  osc7AcceptedHosts,
  useTerminal,
} from '../../panels/Terminal/useTerminal';
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
    // shell 集成(bash/fish)与 oh-my-zsh 等发 `file://<真实 hostname>$PWD` → 本机 hostname 必须被接受
    expect(firstCall[2]).toEqual({ acceptedHosts: ['', 'localhost', 'my-mac.local'] });
  });

  it('T13b: captured onCwd routes to coApi.terminal.updateCwd with termId(尾随合并窗口后)', () => {
    vi.useFakeTimers();
    try {
      render(createElement(Host, { termId: 'term-osc7' }));

      expect(hoisted.capturedOnCwd).toBeDefined();
      hoisted.capturedOnCwd!('/tmp');
      vi.advanceTimersByTime(CWD_REPORT_DEBOUNCE_MS);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledTimes(1);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledWith('term-osc7', '/tmp');
    } finally {
      vi.useRealTimers();
    }
  });

  // perf:每个 prompt 都会发 OSC7;readHistory 回放最多 1MB 历史会把历史中每个 OSC7 重新触发一遍
  // → N 次 updateCwd IPC + N 次 sessions_changed 广播,且 cwd 短暂回退到历史值。
  describe('T13f: updateCwd 去重 + 尾随合并', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('与上次已发送值相同的 cwd 不再发送', () => {
      render(createElement(Host, { termId: 'term-osc7' }));
      hoisted.capturedOnCwd!('/a');
      vi.advanceTimersByTime(CWD_REPORT_DEBOUNCE_MS);
      hoisted.capturedOnCwd!('/a');
      vi.advanceTimersByTime(CWD_REPORT_DEBOUNCE_MS);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledTimes(1);
    });

    it('回放突发(连续多个 OSC7)只发送最终值一次', () => {
      render(createElement(Host, { termId: 'term-osc7' }));
      for (const cwd of ['/h1', '/h2', '/h3', '/h1', '/final']) hoisted.capturedOnCwd!(cwd);
      expect(coApi.terminal.updateCwd).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CWD_REPORT_DEBOUNCE_MS);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledTimes(1);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledWith('term-osc7', '/final');
    });

    it('回放跨多帧解析(间隔 < 窗口)→ 窗口顺延,仍只发最终值', () => {
      render(createElement(Host, { termId: 'term-osc7' }));
      const step = Math.floor(CWD_REPORT_DEBOUNCE_MS * 0.6);
      hoisted.capturedOnCwd!('/h1');
      vi.advanceTimersByTime(step);
      hoisted.capturedOnCwd!('/h2');
      vi.advanceTimersByTime(step);
      expect(coApi.terminal.updateCwd).not.toHaveBeenCalled();
      vi.advanceTimersByTime(CWD_REPORT_DEBOUNCE_MS);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledTimes(1);
      expect(coApi.terminal.updateCwd).toHaveBeenCalledWith('term-osc7', '/h2');
    });

    it('合并窗口内卸载 → 丢弃待发值,不发送', () => {
      const { unmount } = render(createElement(Host, { termId: 'term-osc7' }));
      hoisted.capturedOnCwd!('/pending');
      unmount();
      vi.advanceTimersByTime(CWD_REPORT_DEBOUNCE_MS * 4);
      expect(coApi.terminal.updateCwd).not.toHaveBeenCalled();
    });
  });

  it('T13c: unmount triggers disposable.dispose once', () => {
    const { unmount } = render(createElement(Host, { termId: 'term-osc7' }));

    unmount();

    expect(hoisted.disposeMock).toHaveBeenCalledTimes(1);
  });
});

describe('terminal-osc7 · acceptedHosts', () => {
  it('T13d: hostname 不可得(null / undefined)→ 仅接受空 host / localhost', () => {
    expect(osc7AcceptedHosts(null)).toEqual(['', 'localhost']);
    expect(osc7AcceptedHosts(undefined)).toEqual(['', 'localhost']);
    expect(osc7AcceptedHosts('box')).toEqual(['', 'localhost', 'box']);
  });

  it('T13e: 真实 parser 下,发本机 hostname 的 payload 被接受、他机 hostname 仍被拒', async () => {
    const { parseOsc7Cwd } = await vi.importActual<
      typeof import('@continuo-terminal/react-terminal')
    >('@continuo-terminal/react-terminal');
    const opts = { acceptedHosts: osc7AcceptedHosts('my-mac.local') };
    expect(parseOsc7Cwd('file://my-mac.local/Users/me/proj', opts)).toBe('/Users/me/proj');
    expect(parseOsc7Cwd('file:///Users/me', opts)).toBe('/Users/me');
    expect(parseOsc7Cwd('file://other-host/Users/me', opts)).toBeNull();
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
