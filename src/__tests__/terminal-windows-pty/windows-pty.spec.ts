// @vitest-environment jsdom
// Windows 上 xterm 获知 PTY 后端与系统 build 号(见同目录 README)。
//
// xterm 6 未设 windowsPty.buildNumber 时 Windows 仍开 reflow:ConPTY(build < 21376)下每次列数
// 变化对 20000 行 scrollback 做 O(N) _reflow,且与 ConPTY 自身重绘冲突。main 经 additionalArguments
// 注入 build 号 → preload 解析为 coApi.system.windowsBuild → useTerminal 在 Windows 上传
// windowsPty: { backend, buildNumber }(同 VS Code)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const hoisted = vi.hoisted(() => ({
  system: { windowId: 1, hostname: 'box', windowsBuild: null as number | null },
}));

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
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    terminal: {
      resize: vi.fn().mockResolvedValue({ ok: true }),
      updateCwd: vi.fn().mockResolvedValue({ ok: true }),
      onData: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
    system: hoisted.system,
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_k: string, fb: T) => fb,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { Terminal } from '@xterm/xterm';
import { terminalWindowsPtyOptions, useTerminal } from '../../panels/Terminal/useTerminal';
import {
  buildCommonWebPreferences,
  buildContinuoWindowsBuildArg,
  parseWindowsBuildNumber,
} from '../../../electron/main/continuo-meta-args';
import { parseContinuoWindowsBuildFromArgv } from '../../../electron/preload/continuo-meta-parse';

function Host({ termId }: { termId: string }) {
  const { containerRef } = useTerminal(termId);
  return createElement('div', { ref: containerRef });
}

function stubPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', { configurable: true, get: () => platform });
}

function lastTerminalOptions(): Record<string, unknown> {
  const calls = vi.mocked(Terminal).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
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
  hoisted.system.windowsBuild = null;
  stubPlatform('MacIntel');
});

describe('terminal-windows-pty · xterm 获知 Windows PTY 后端与 build 号', () => {
  it('Windows + build 号 → new Terminal 带 windowsPty { conpty, buildNumber }', () => {
    stubPlatform('Win32');
    hoisted.system.windowsBuild = 19045;
    render(createElement(Host, { termId: 't-win' }));
    expect(lastTerminalOptions().windowsPty).toEqual({ backend: 'conpty', buildNumber: 19045 });
  });

  it('非 Windows → 不带 windowsPty(即便误注入了 build 号)', () => {
    stubPlatform('MacIntel');
    hoisted.system.windowsBuild = 19045;
    render(createElement(Host, { termId: 't-mac' }));
    expect(lastTerminalOptions()).not.toHaveProperty('windowsPty');
  });

  it('Windows 但拿不到 build 号 → 不猜,不带 windowsPty(维持旧行为)', () => {
    stubPlatform('Win32');
    hoisted.system.windowsBuild = null;
    render(createElement(Host, { termId: 't-win-unknown' }));
    expect(lastTerminalOptions()).not.toHaveProperty('windowsPty');
  });

  it('后端与 node-pty 默认一致:build ≥ 18309 → conpty,更低 → winpty', () => {
    expect(terminalWindowsPtyOptions(true, 22631)).toEqual({
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
    });
    expect(terminalWindowsPtyOptions(true, 17763)).toEqual({
      windowsPty: { backend: 'winpty', buildNumber: 17763 },
    });
    expect(terminalWindowsPtyOptions(false, 22631)).toEqual({});
    expect(terminalWindowsPtyOptions(true, null)).toEqual({});
    expect(terminalWindowsPtyOptions(true, undefined)).toEqual({});
  });
});

describe('terminal-windows-pty · main 注入 / preload 解析 build 号', () => {
  it('os.release() → build 号(第三段);非法 → null', () => {
    expect(parseWindowsBuildNumber('10.0.19045')).toBe(19045);
    expect(parseWindowsBuildNumber('10.0.22631')).toBe(22631);
    expect(parseWindowsBuildNumber('10.0')).toBeNull();
    expect(parseWindowsBuildNumber('10.0.abc')).toBeNull();
    expect(parseWindowsBuildNumber('')).toBeNull();
  });

  it('只在 win32 注入 --continuo-windows-build', () => {
    expect(buildContinuoWindowsBuildArg(19045)).toBe('--continuo-windows-build=19045');
    expect(
      buildCommonWebPreferences({ platform: 'win32', osRelease: '10.0.19045' }).additionalArguments,
    ).toContain('--continuo-windows-build=19045');
    expect(
      buildCommonWebPreferences({ platform: 'darwin', osRelease: '24.6.0' }).additionalArguments?.some(
        (a) => a.startsWith('--continuo-windows-build='),
      ),
    ).toBe(false);
    expect(
      buildCommonWebPreferences({ platform: 'win32', osRelease: 'garbage' }).additionalArguments?.some(
        (a) => a.startsWith('--continuo-windows-build='),
      ),
    ).toBe(false);
  });

  it('preload 解析:正整数 → number;缺失 / 非法 → null', () => {
    expect(parseContinuoWindowsBuildFromArgv(['exe', '--continuo-windows-build=19045'])).toBe(19045);
    expect(parseContinuoWindowsBuildFromArgv(['exe'])).toBeNull();
    expect(parseContinuoWindowsBuildFromArgv(['exe', '--continuo-windows-build='])).toBeNull();
    expect(parseContinuoWindowsBuildFromArgv(['exe', '--continuo-windows-build=abc'])).toBeNull();
    expect(parseContinuoWindowsBuildFromArgv(['exe', '--continuo-windows-build=-1'])).toBeNull();
    expect(parseContinuoWindowsBuildFromArgv(['exe', '--continuo-windows-build=1e5'])).toBeNull();
  });
});
