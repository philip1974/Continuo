// @vitest-environment jsdom
// BDD: win-linux-parity / 3 Windows / Linux 只有原生标题栏、4 菜单栏助记符、8 非 mac 不再 Ctrl+M 最小化
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({
  FakeBrowserWindow: class FakeBrowserWindow {
    minimize = vi.fn();
  },
}));
vi.mock('electron', () => ({
  app: { name: 'Continuo' },
  BrowserWindow: mocks.FakeBrowserWindow,
}));
vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand: vi.fn(() => true), runEditUndoRedo: vi.fn() }));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    window: {
      getZoomFactor: () => 1,
      isFullScreen: async () => ({ ok: true as const, data: false }),
      onFullScreenChange: () => () => {},
    },
  },
}));

import { TitleBar } from '../../shell/TitleBar';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { appMenuTemplate, type AppMenuActions } from '../../../electron/main/app-menu';
import { mnemonicMenuLabel } from '../../../electron/main/menu-mnemonic';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

type Item = MenuItemConstructorOptions;

let platformDescriptor: PropertyDescriptor | undefined;
const setPlatform = (value: string) =>
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });
beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useWorkspaceStore.setState({ root: null });
});
afterEach(() => {
  cleanup();
  if (platformDescriptor) Object.defineProperty(Navigator.prototype, 'platform', platformDescriptor);
});

describe('3 标题栏:Windows / Linux 只有原生标题栏', () => {
  it.each(['Win32', 'Linux x86_64'])('%s:不渲染应用内标题栏;窗口标题照常同步', (platform) => {
    setPlatform(platform);
    useWorkspaceStore.setState({ root: '/Users/foo/projects/myapp' });
    const { container } = render(<TitleBar />);
    expect(container.querySelector('header')).toBeNull();
    expect(container.textContent).toBe('');
    expect(document.title).toBe('myapp');
  });
  it('macOS:照常渲染(hiddenInset 下兼作拖窗区)', () => {
    setPlatform('MacIntel');
    useWorkspaceStore.setState({ root: '/Users/foo/projects/myapp' });
    const { container } = render(<TitleBar />);
    expect(container.querySelector('header')?.textContent).toContain('myapp');
  });
});

const actions: AppMenuActions = { newWindow: vi.fn(), openFolderInNewWindow: vi.fn(), reloadWindow: vi.fn(), openHelpLink: vi.fn(), showAbout: vi.fn() };
const tOf = (catalog: Record<string, string>) => (key: string, params?: Record<string, string>) =>
  (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_m, p: string) => params?.[p] ?? '');
const topLabels = (catalog: Record<string, string>, isMac: boolean) =>
  appMenuTemplate(tOf(catalog) as never, actions, isMac, () => undefined, () => false).map((m) => m.label);
const flatten = (items: readonly Item[]): Item[] =>
  items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);

describe('4 菜单栏助记符(VSCode mnemonicMenuLabel)', () => {
  it('Windows / Linux:顶层菜单 Alt+F / E / S / V / G / T / W / H(en / zh / ko 同 VSCode 语言包写法)', () => {
    expect(topLabels(en, false)).toEqual(['&File', '&Edit', '&Selection', '&View', '&Go', '&Terminal', '&Window', '&Help']);
    expect(topLabels(zh, false)).toEqual(['文件(&F)', '编辑(&E)', '选择(&S)', '查看(&V)', '转到(&G)', '终端(&T)', '窗口(&W)', '帮助(&H)']);
    expect(topLabels(ko, false)).toEqual(['파일(&F)', '편집(&E)', '선택 영역(&S)', '보기(&V)', '이동(&G)', '터미널(&T)', '창(&W)', '도움말(&H)']);
  });
  it('macOS:去掉助记符', () => {
    expect(topLabels(en, true)).toEqual(['Continuo', 'File', 'Edit', 'Selection', 'View', 'Go', 'Terminal', 'Window', 'Help']);
    expect(topLabels(zh, true)).toEqual(['Continuo', '文件', '编辑', '选择', '查看', '转到', '终端', '窗口', '帮助']);
  });
  it('标签文本里本身的 & 转义(Windows / Linux `&&` 显示为 &);macOS 原样', () => {
    expect(mnemonicMenuLabel('Find & Replace', false)).toBe('Find && Replace');
    expect(mnemonicMenuLabel('Find & Replace', true)).toBe('Find & Replace');
    expect(mnemonicMenuLabel('&&File', false)).toBe('&File');
    expect(mnemonicMenuLabel('文件(&&F)', true)).toBe('文件');
  });
  it('子菜单项没有多出来的 &(catalog 里不含 &)', () => {
    const items = flatten(appMenuTemplate(tOf(en) as never, actions, false, () => undefined, () => false));
    const subLabels = items.filter((m) => typeof m.label === 'string' && !Array.isArray(m.submenu)).map((m) => m.label!);
    expect(subLabels.length).toBeGreaterThan(30);
    expect(subLabels.filter((l) => l.includes('&'))).toEqual([]);
  });
});

describe('8 窗口菜单「最小化」', () => {
  const windowMenu = (isMac: boolean) =>
    appMenuTemplate(tOf(en) as never, actions, isMac, () => undefined, () => false).find((m) => m.role === 'windowMenu')!
      .submenu as Item[];
  it('Windows / Linux:不用 role minimize(其默认 Ctrl+M),无键位;点击最小化获焦窗口', () => {
    const [minimize] = windowMenu(false);
    expect(minimize).toMatchObject({ label: 'Minimize' });
    expect(minimize!.role).toBeUndefined();
    expect(minimize!.accelerator).toBeUndefined();
    const win = new mocks.FakeBrowserWindow();
    minimize!.click!(minimize as never, win as never, {} as never);
    expect(win.minimize).toHaveBeenCalledTimes(1);
  });
  it('macOS:保留 role minimize(⌘M)', () => {
    expect(windowMenu(true)[0]!.role).toBe('minimize');
  });
});
