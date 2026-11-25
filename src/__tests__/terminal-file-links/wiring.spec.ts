// @vitest-environment jsdom
// BDD: terminal-file-links / 4 useTerminal 接线:注册 link provider;修饰键单击在编辑器打开并定位行列;悬停提示;cwd 取自会话
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const h = vi.hoisted(() => ({
  registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
  resolveLinks: vi.fn(),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function TerminalMock(this: Record<string, unknown>, options: Record<string, unknown>) {
    Object.assign(this, {
      cols: 80,
      rows: 24,
      options,
      loadAddon: vi.fn(),
      open: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      registerLinkProvider: h.registerLinkProvider,
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
      resolveLinks: h.resolveLinks,
      onData: vi.fn(() => vi.fn()),
      readHistory: vi.fn().mockResolvedValue({ ok: true, data: { data: '' } }),
      write: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
}));
vi.mock('@/plugins/settings/values-store', () => ({ useSettingValue: <T,>(_k: string, fb: T) => fb }));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('@/panels/Terminal/terminal-file-links', async (importActual) => {
  const actual = await importActual<typeof import('@/panels/Terminal/terminal-file-links')>();
  return { ...actual, createTerminalFileLinkProvider: vi.fn(actual.createTerminalFileLinkProvider) };
});

import { createTerminalFileLinkProvider, type TerminalFileLinkDeps } from '@/panels/Terminal/terminal-file-links';
import { terminalFileLinkHoverHint, useTerminal } from '@/panels/Terminal/useTerminal';
import { coApp } from '@/plugins/co-app';
import { useTerminalStore } from '@/stores/terminal.store';
import { setLocale } from '@/i18n';

function Host() {
  const { containerRef } = useTerminal('term-f');
  return createElement('div', { ref: containerRef, 'data-testid': 'host' });
}

let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  setLocale('zh');
  platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useTerminalStore.setState({ sessions: [] });
  if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
  setLocale('en');
});

function mountDeps(): TerminalFileLinkDeps {
  render(createElement(Host));
  expect(h.registerLinkProvider).toHaveBeenCalledTimes(1);
  return vi.mocked(createTerminalFileLinkProvider).mock.calls[0]![1];
}

describe('useTerminal 文件链接接线', () => {
  it('修饰键单击才打开;打开时带行列;无行号不带', () => {
    const open = vi.spyOn(coApp.editor, 'openFile').mockResolvedValue({ ok: true, lineApplied: true });
    const deps = mountDeps();
    deps.open('/w/src/a.ts', 2, 5, new MouseEvent('click'));
    expect(open).not.toHaveBeenCalled();
    deps.open('/w/src/a.ts', 2, 5, new MouseEvent('click', { metaKey: true }));
    expect(open).toHaveBeenCalledWith('/w/src/a.ts', { line: 2, column: 5 });
    deps.open('/w/b.md', undefined, undefined, new MouseEvent('click', { metaKey: true }));
    expect(open).toHaveBeenLastCalledWith('/w/b.md', undefined);
    open.mockRestore();
  });
  it('悬停提示「⌘+单击打开文件」,离开移除', () => {
    const deps = mountDeps();
    const host = document.querySelector<HTMLElement>('[data-testid=host]')!;
    deps.hover!(new MouseEvent('mousemove'), 'src/a.ts');
    expect(host.title).toBe('⌘+单击打开文件');
    expect(terminalFileLinkHoverHint('other')).toBe('Ctrl+单击打开文件');
    deps.leave!(new MouseEvent('mouseleave'), 'src/a.ts');
    expect(host.hasAttribute('title')).toBe(false);
  });
  it('cwd 取自会话快照;解析走 terminal:resolve_links,失败 / 形态不符 → null', async () => {
    useTerminalStore.setState({
      sessions: [
        { id: 'term-f', title: 'T', cwd: '/w/pkg', originHint: 'user', createdAt: 1, exitCode: null, ownerWindowId: 1 },
      ],
    });
    const deps = mountDeps();
    expect(deps.getCwd()).toBe('/w/pkg');
    h.resolveLinks.mockResolvedValueOnce({ ok: true, data: ['/w/pkg/a.ts', null] });
    expect(await deps.resolve(['a.ts', 'b.ts'])).toEqual(['/w/pkg/a.ts', null]);
    expect(h.resolveLinks).toHaveBeenCalledWith('term-f', ['a.ts', 'b.ts']);
    h.resolveLinks.mockResolvedValueOnce({ ok: false, code: 'X' });
    expect(await deps.resolve(['a.ts'])).toBeNull();
    h.resolveLinks.mockResolvedValueOnce({ ok: true, data: [] });
    expect(await deps.resolve(['a.ts'])).toBeNull();
    h.resolveLinks.mockRejectedValueOnce(new Error('ipc'));
    expect(await deps.resolve(['a.ts'])).toBeNull();
  });
});
