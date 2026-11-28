// @vitest-environment jsdom
// BDD:新建 / 激活的终端挂载后焦点直接进 xterm;不活动(agent 后台创建)的终端不抢焦点。见同目录 README 第 2 条。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  terminalOptions: [] as Array<Record<string, unknown>>,
  fontSize: 13,
  resolved: 'dark' as 'dark' | 'light',
  size: 0,
  resizeCallbacks: [] as Array<() => void>,
  focusCalls: 0,
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
    h.terminalOptions.push({ ...options });
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
      focus: vi.fn(() => {
        h.focusCalls += 1;
      }),
    });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
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
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(key: string, fallback: T) =>
    key === 'terminal.integrated.fontSize' ? (h.fontSize as unknown as T) : fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: h.resolved }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { Modal, type ModalProps } from '../../design/Modal';

function Host({ active }: { active: () => boolean }) {
  const { containerRef } = useTerminal('term-1', { focusOnInit: active });
  return createElement('div', { ref: containerRef });
}

beforeEach(() => {
  h.terminalOptions.length = 0;
  h.resizeCallbacks.length = 0;
  h.focusCalls = 0;
  h.size = 400;
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => h.size });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => h.size });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(cb: () => void) {
        h.resizeCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    },
  });
});

afterEach(() => cleanup());

describe('新建终端挂载即聚焦', () => {
  it('面板挂载时已是活动面板 → xterm 创建后立即 focus(无需再等激活事件)', () => {
    render(createElement(Host, { active: () => true }));
    expect(h.terminalOptions).toHaveLength(1);
    expect(h.focusCalls).toBe(1);
  });

  it('0 尺寸挂载、延迟创建:创建那一刻仍是活动面板才 focus', () => {
    h.size = 0;
    let active = true;
    render(createElement(Host, { active: () => active }));
    expect(h.focusCalls).toBe(0);
    h.size = 400;
    act(() => h.resizeCallbacks.forEach((cb) => cb()));
    expect(h.focusCalls).toBe(1);

    cleanup();
    h.focusCalls = 0;
    h.size = 0;
    h.resizeCallbacks.length = 0;
    render(createElement(Host, { active: () => active }));
    active = false; // 创建前用户已切走
    h.size = 400;
    act(() => h.resizeCallbacks.forEach((cb) => cb()));
    expect(h.focusCalls).toBe(0);
  });

  it('有 Modal 开着(删除确认 / 授权框):xterm 晚挂载也不抢焦点', () => {
    h.size = 0;
    render(
      createElement('div', null, createElement(Host, { active: () => true }), createElement(Modal, { visible: true } as ModalProps, 'confirm')),
    );
    h.size = 400;
    act(() => h.resizeCallbacks.forEach((cb) => cb()));
    expect(h.terminalOptions).toHaveLength(1);
    expect(h.focusCalls).toBe(0);
  });

  it('非活动面板(agent 后台创建,不抢焦点)→ 不 focus', () => {
    render(createElement(Host, { active: () => false }));
    expect(h.terminalOptions).toHaveLength(1);
    expect(h.focusCalls).toBe(0);
  });
});
