// @vitest-environment jsdom
// BDD: high-contrast-theme —— 终端随主题切换:HC 两套 xterm 配色(VSCode terminalColorRegistry 的 hcDark / hcLight 16 色)与
// minimumContrastRatio 7;已开终端切主题即换(不重建)。见同目录 README「1」与「刻意差异」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  terms: [] as Array<{ options: Record<string, unknown> }>,
  resolved: 'dark' as 'light' | 'dark' | 'hcDark' | 'hcLight',
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
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      clearSelection: vi.fn(),
      focus: vi.fn(),
      dispose: vi.fn(),
    });
    h.terms.push(this as unknown as { options: Record<string, unknown> });
  }),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn(() => ({
    findNext: vi.fn(),
    findPrevious: vi.fn(),
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
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: h.resolved }) }));

import { terminalMinimumContrastRatio, terminalThemeFor, useTerminal } from '@/panels/Terminal/useTerminal';

afterEach(() => cleanup());

describe('终端 HC 配色', () => {
  it('hcDark:黑底白字,16 色 = VSCode terminal.ansi* hcDark;选区白底黑字', () => {
    const t = terminalThemeFor('hcDark');
    expect(t).toMatchObject({
      background: '#000000',
      foreground: '#ffffff',
      selectionBackground: '#ffffff',
      selectionForeground: '#000000',
      black: '#000000',
      red: '#cd0000',
      green: '#00cd00',
      yellow: '#cdcd00',
      blue: '#0000ee',
      magenta: '#cd00cd',
      cyan: '#00cdcd',
      white: '#e5e5e5',
      brightBlack: '#7f7f7f',
      brightRed: '#ff0000',
      brightGreen: '#00ff00',
      brightYellow: '#ffff00',
      brightBlue: '#5c5cff',
      brightMagenta: '#ff00ff',
      brightCyan: '#00ffff',
      brightWhite: '#ffffff',
    });
  });

  it('hcLight:白底 #292929,16 色 = VSCode terminal.ansi* hcLight;选区 #0f4a85 白字', () => {
    expect(terminalThemeFor('hcLight')).toMatchObject({
      background: '#ffffff',
      foreground: '#292929',
      selectionBackground: '#0f4a85',
      selectionForeground: '#ffffff',
      black: '#292929',
      red: '#cd3131',
      green: '#136c13',
      yellow: '#949800',
      blue: '#0451a5',
      magenta: '#bc05bc',
      cyan: '#0598bc',
      white: '#555555',
      brightBlack: '#666666',
      brightRed: '#cd3131',
      brightGreen: '#00bc00',
      brightYellow: '#b5ba00',
      brightBlue: '#0451a5',
      brightMagenta: '#bc05bc',
      brightCyan: '#0598bc',
      brightWhite: '#a5a5a5',
    });
  });

  it('四套互不相同;minimumContrastRatio:HC 两套 7', () => {
    const all = (['light', 'dark', 'hcDark', 'hcLight'] as const).map(terminalThemeFor);
    expect(new Set(all).size).toBe(4);
    expect(terminalMinimumContrastRatio('hcDark')).toBe(7);
    expect(terminalMinimumContrastRatio('hcLight')).toBe(7);
  });
});

describe('已开终端随主题切换', () => {
  beforeEach(() => {
    h.terms = [];
    h.resolved = 'dark';
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 });
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

  function Host({ termId }: { termId: string }) {
    const { containerRef } = useTerminal(termId);
    return createElement('div', { ref: containerRef });
  }

  it('新建按当前主题开局;切到 hcDark / hcLight → 已有 term 换 HC 配色与 minimumContrastRatio 7(不重建)', () => {
    h.resolved = 'hcLight';
    const { rerender } = render(createElement(Host, { termId: 'hc-1' }));
    expect(h.terms).toHaveLength(1);
    const term = h.terms[0]!;
    expect(term.options.theme).toBe(terminalThemeFor('hcLight'));
    expect(term.options.minimumContrastRatio).toBe(7);

    h.resolved = 'dark';
    rerender(createElement(Host, { termId: 'hc-1' }));
    expect(term.options.theme).toBe(terminalThemeFor('dark'));
    expect(term.options.minimumContrastRatio).toBe(terminalMinimumContrastRatio('dark'));

    h.resolved = 'hcDark';
    rerender(createElement(Host, { termId: 'hc-1' }));
    expect(term.options.theme).toBe(terminalThemeFor('hcDark'));
    expect(term.options.minimumContrastRatio).toBe(7);
    expect(h.terms).toHaveLength(1);
  });
});
