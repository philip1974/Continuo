// @vitest-environment jsdom
// BDD: font-settings —— 终端字体族 / 行高:创建时用设置值;改设置即时写到已有 xterm(不重建),随后 fit 重排行列;终端字体留空
// 跟随编辑器字体。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  terms: [] as Array<{ options: Record<string, unknown> }>,
  settings: new Map<string, unknown>(),
  fits: 0,
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
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(() => ({
    fit: () => {
      h.fits += 1;
    },
  })),
}));
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
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(key: string, fallback: T) => (h.settings.has(key) ? (h.settings.get(key) as T) : fallback),
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { useTerminal } from '../../panels/Terminal/useTerminal';
import { DEFAULT_TERMINAL_FONT_FAMILY } from '@/plugins/settings/font-settings';

function Host({ tick }: { tick: number }) {
  const { containerRef } = useTerminal('term-1');
  return createElement('div', { ref: containerRef, 'data-tick': tick });
}

beforeEach(() => {
  h.terms.length = 0;
  h.settings.clear();
  h.fits = 0;
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

const options = () => h.terms[0]!.options;

describe('终端字体族 / 行高', () => {
  it('默认:终端自带 Nerd Font 字体链、行高 1', () => {
    render(createElement(Host, { tick: 0 }));
    expect(h.terms).toHaveLength(1);
    expect(options().fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(options().lineHeight).toBe(1);
  });

  it('创建时就用设置值(终端字体空 → 跟随编辑器字体;行高越界夹取)', () => {
    h.settings.set('editor.fontFamily', 'Fira Code');
    h.settings.set('terminal.integrated.lineHeight', 0.3);
    render(createElement(Host, { tick: 0 }));
    expect(options().fontFamily).toMatch(/^"Fira Code", /);
    expect(options().lineHeight).toBe(1);
  });

  it('改字体族 / 行高 → 写到已有 xterm(不重建)并重新 fit;只改光标样式不 fit', () => {
    const view = render(createElement(Host, { tick: 0 }));
    const fitsAfterMount = h.fits;

    h.settings.set('terminal.integrated.fontFamily', 'Hack');
    view.rerender(createElement(Host, { tick: 1 }));
    expect(h.terms).toHaveLength(1);
    expect(options().fontFamily).toMatch(/^"Hack", .*monospace$/);
    expect(h.fits).toBeGreaterThan(fitsAfterMount);

    const fitsAfterFont = h.fits;
    h.settings.set('terminal.integrated.lineHeight', 1.5);
    view.rerender(createElement(Host, { tick: 2 }));
    expect(options().lineHeight).toBe(1.5);
    expect(h.fits).toBeGreaterThan(fitsAfterFont);

    const fitsAfterLineHeight = h.fits;
    h.settings.set('terminal.cursorStyle', 'bar');
    view.rerender(createElement(Host, { tick: 3 }));
    expect(options().cursorStyle).toBe('bar');
    expect(h.fits).toBe(fitsAfterLineHeight);
  });

  it('终端字体优先于编辑器字体;清空终端字体 → 跟随编辑器字体', () => {
    h.settings.set('terminal.integrated.fontFamily', 'Hack');
    const view = render(createElement(Host, { tick: 0 }));
    h.settings.set('editor.fontFamily', 'Fira Code');
    view.rerender(createElement(Host, { tick: 1 }));
    expect(options().fontFamily).toMatch(/^"Hack", /);
    h.settings.set('terminal.integrated.fontFamily', '  ');
    view.rerender(createElement(Host, { tick: 2 }));
    expect(options().fontFamily).toMatch(/^"Fira Code", /);
  });
});
