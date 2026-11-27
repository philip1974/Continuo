// @vitest-environment jsdom
// BDD: terminal-screen-reader —— editor.accessibilitySupport(auto / on / off)+ 系统读屏检测 → xterm screenReaderMode:
// 创建时带判定,变化即时同步到所有已开终端(不重建)。见同目录 README 行为 2、3、4。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  terms: [] as Array<{ options: Record<string, unknown> }>,
  settings: new Map<string, unknown>(),
  pushListeners: [] as Array<(enabled: boolean) => void>,
  resolveGet: null as ((r: { ok: true; data: boolean }) => void) | null,
}));

vi.mock('@continuo-terminal/react-terminal', async (importActual) => {
  const actual = await importActual<typeof import('@continuo-terminal/react-terminal')>();
  return { ...actual, registerOsc7Cwd: vi.fn(() => ({ dispose: vi.fn() })) };
});
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options: { ...options },
      buffer: { normal: { length: 0 } },
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
    h.terms.push(this as unknown as { options: Record<string, unknown> });
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
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: vi.fn(() => ({ onContextLoss: vi.fn(), dispose: vi.fn() })) }));
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
    accessibility: {
      getSupport: vi.fn(
        () =>
          new Promise((resolve) => {
            h.resolveGet = resolve;
          }),
      ),
      onSupportChanged: vi.fn((cb: (enabled: boolean) => void) => {
        h.pushListeners.push(cb);
        return () => {};
      }),
    },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(key: string, fallback: T) => (h.settings.has(key) ? (h.settings.get(key) as T) : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { _resetAccessibilitySupportForTest, isScreenReaderOptimized } from '@/lib/accessibility-support';
import { EDITOR_ACCESSIBILITY_SUPPORT } from '@/plugins/settings/core-setting-specs';

function Host({ id, tick }: { id: string; tick: number }) {
  const { containerRef } = useTerminal(id);
  return createElement('div', { ref: containerRef, 'data-tick': tick });
}

function Two({ tick }: { tick: number }) {
  return createElement('div', null, createElement(Host, { id: 't1', tick }), createElement(Host, { id: 't2', tick }));
}

const push = (enabled: boolean) => act(() => h.pushListeners.forEach((cb) => cb(enabled)));
const modes = () => h.terms.map((t) => t.options.screenReaderMode);

beforeEach(() => {
  h.terms.length = 0;
  h.settings.clear();
  h.pushListeners.length = 0;
  h.resolveGet = null;
  _resetAccessibilitySupportForTest();
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      disconnect(): void {}
    },
  });
});
afterEach(() => cleanup());

describe('判定(同 VSCode isScreenReaderOptimized)', () => {
  it('on → 开;off → 关;auto → 跟随系统检测', () => {
    expect(isScreenReaderOptimized('on', false)).toBe(true);
    expect(isScreenReaderOptimized('off', true)).toBe(false);
    expect(isScreenReaderOptimized('auto', true)).toBe(true);
    expect(isScreenReaderOptimized('auto', false)).toBe(false);
  });

  it('设置项 editor.accessibilitySupport:auto / on / off,默认 auto', () => {
    expect(EDITOR_ACCESSIBILITY_SUPPORT.id).toBe('editor.accessibilitySupport');
    expect(EDITOR_ACCESSIBILITY_SUPPORT.default).toBe('auto');
    expect(EDITOR_ACCESSIBILITY_SUPPORT.enum?.map((o) => o.value)).toEqual(['auto', 'on', 'off']);
  });
});

describe('终端 screenReaderMode', () => {
  it('默认(auto + 未检测到读屏)→ 创建时关', () => {
    render(createElement(Host, { id: 't1', tick: 0 }));
    expect(modes()).toEqual([false]);
  });

  it('设置 on → 创建时即开', () => {
    h.settings.set('editor.accessibilitySupport', 'on');
    render(createElement(Host, { id: 't1', tick: 0 }));
    expect(modes()).toEqual([true]);
  });

  it('改设置 → 已开终端即时切换(不重建)', () => {
    const view = render(createElement(Host, { id: 't1', tick: 0 }));
    h.settings.set('editor.accessibilitySupport', 'on');
    view.rerender(createElement(Host, { id: 't1', tick: 1 }));
    expect(h.terms).toHaveLength(1);
    expect(modes()).toEqual([true]);
    h.settings.set('editor.accessibilitySupport', 'off');
    view.rerender(createElement(Host, { id: 't1', tick: 2 }));
    expect(modes()).toEqual([false]);
  });

  it('auto:系统读屏开 / 关的推送 → 所有已开终端即时切换;off 时推送不影响', () => {
    const view = render(createElement(Two, { tick: 0 }));
    expect(modes()).toEqual([false, false]);
    push(true);
    expect(modes()).toEqual([true, true]);
    push(false);
    expect(modes()).toEqual([false, false]);

    h.settings.set('editor.accessibilitySupport', 'off');
    view.rerender(createElement(Two, { tick: 1 }));
    push(true);
    expect(modes()).toEqual([false, false]);
    expect(h.terms).toHaveLength(2);
  });

  it('auto:初值(main 检测到读屏)→ 开', async () => {
    render(createElement(Host, { id: 't1', tick: 0 }));
    await act(async () => h.resolveGet?.({ ok: true, data: true }));
    expect(modes()).toEqual([true]);
  });

  it('变化推送先于初值到达 → 迟到的初值作废', async () => {
    render(createElement(Host, { id: 't1', tick: 0 }));
    push(true);
    await act(async () => h.resolveGet?.({ ok: true, data: false }));
    expect(modes()).toEqual([true]);
  });
});
