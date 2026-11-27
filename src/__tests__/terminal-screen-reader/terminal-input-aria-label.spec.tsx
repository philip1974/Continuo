// @vitest-environment jsdom
// BDD: terminal-screen-reader —— 终端输入框可访问名:三语、带序号 / 标题(VSCode「Terminal 1, zsh」);xterm open 写的英文
// 「Terminal input」被覆盖;改名 / 切语言即时同步。见同目录 README 行为 5。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  terms: [] as Array<{ textarea?: HTMLTextAreaElement }>,
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
      open: vi.fn(function open(this: Record<string, unknown>, el: HTMLElement) {
        // 同 xterm 6:open 时建 helper textarea 并写内置英文名
        const ta = el.ownerDocument.createElement('textarea');
        ta.setAttribute('aria-label', 'Terminal input');
        el.appendChild(ta);
        this.textarea = ta;
      }),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
      parser: { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) },
      dispose: vi.fn(),
    });
    h.terms.push(this as unknown as { textarea?: HTMLTextAreaElement });
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
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_key: string, fallback: T) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));

import { setLocale } from '@/i18n';
import { useTerminal } from '../../panels/Terminal/useTerminal';
import { terminalInputAriaLabel } from '@/shell/dock/terminal-panel-id';

function Host({ label }: { label: string }) {
  const { containerRef } = useTerminal('t1', { inputAriaLabel: label });
  return createElement('div', { ref: containerRef });
}

beforeEach(() => {
  setLocale('en');
  h.terms.length = 0;
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
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('terminalInputAriaLabel', () => {
  const base = { sessionId: 'abcdef123', defaultTitleIndex: 2 };

  it('en:有序号与进程名 →「Terminal 2, zsh」;标题就是默认名 → 只读「Terminal 2」;无序号 →「Terminal, 标题」', () => {
    expect(terminalInputAriaLabel({ ...base, processName: 'zsh' })).toBe('Terminal 2, zsh');
    expect(terminalInputAriaLabel(base)).toBe('Terminal 2');
    expect(terminalInputAriaLabel({ sessionId: 'abcdef123', userTitle: 'build' })).toBe('Terminal, build');
  });

  it('zh / ko 本地化', () => {
    setLocale('zh');
    expect(terminalInputAriaLabel({ ...base, processName: 'zsh' })).toBe('终端 2，zsh');
    expect(terminalInputAriaLabel(base)).toBe('终端 2');
    setLocale('ko');
    expect(terminalInputAriaLabel({ ...base, processName: 'zsh' })).toBe('터미널 2, zsh');
    expect(terminalInputAriaLabel({ sessionId: 'abcdef123', userTitle: 'build' })).toBe('터미널, build');
  });
});

describe('useTerminal 写输入框可访问名', () => {
  it('open 之后覆盖 xterm 内置的「Terminal input」;值变化即时同步', () => {
    const view = render(createElement(Host, { label: '终端 1，zsh' }));
    const ta = h.terms[0]!.textarea!;
    expect(ta.getAttribute('aria-label')).toBe('终端 1，zsh');
    view.rerender(createElement(Host, { label: '터미널 1, vim' }));
    expect(h.terms).toHaveLength(1);
    expect(ta.getAttribute('aria-label')).toBe('터미널 1, vim');
  });
});
