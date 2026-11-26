// BDD: command-discoverability —— 应用菜单随界面语言(role 项带三语 label、Edit / View / Window 显式子项),
// 应用菜单有「设置… ⌘,」= 命令 settings.toggle(在 首选项 ▸ 子菜单里,见 app-menu-bar)。见同目录 README 第 1 条。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({
  sendMenuCommand: vi.fn(() => true),
  FakeBrowserWindow: class FakeBrowserWindow {},
}));

vi.mock('electron', () => ({
  app: { name: 'Continuo' },
  BrowserWindow: mocks.FakeBrowserWindow,
}));
vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand: mocks.sendMenuCommand }));

import { appMenuTemplate, type AppMenuActions } from '../../../electron/main/app-menu';
import { MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';
import { setMenuKeybindings } from '../../../electron/main/menu-keybindings';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';

type Item = MenuItemConstructorOptions;

/** t 原样返回 key(便于断言用的是哪条 catalog 文案)。 */
const t = (key: string): string => key;

const actions: AppMenuActions = {
  newWindow: vi.fn(),
  openFolderInNewWindow: vi.fn(),
  reloadWindow: vi.fn(),
};

function template(isMac: boolean): Item[] {
  return appMenuTemplate(t as never, actions, isMac);
}

function flatten(items: readonly Item[]): Item[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

function submenuOf(items: readonly Item[], role: Item['role']): Item[] {
  const menu = items.find((m) => m.role === role);
  if (!menu || !Array.isArray(menu.submenu)) throw new Error(`missing explicit ${String(role)} submenu`);
  return menu.submenu;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  ['mac', true],
  ['other', false],
] as const)('%s:菜单标签随界面语言', (_name, isMac) => {
  it('每个 role 项都带 menu.* 的 label(role 保留);分隔线以外没有无标签项', () => {
    const items = flatten(template(isMac)).filter((m) => m.type !== 'separator');
    expect(items.some((m) => m.role === 'quit')).toBe(true);
    for (const item of items) {
      // 应用菜单(macOS)顶层标签就是应用名
      if (item.label === 'Continuo') continue;
      expect(item.label, String(item.role)).toMatch(/^menu\./);
    }
  });

  it('Edit / View / Window 为显式子项(不用 Electron 默认英文子菜单)', () => {
    const top = template(isMac);
    const edit = submenuOf(top, 'editMenu').map((m) => m.role).filter(Boolean);
    expect(edit).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']));
    const view = submenuOf(top, 'viewMenu').map((m) => m.role).filter(Boolean);
    expect(view).toEqual(['toggleDevTools', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen']);
    const win = submenuOf(top, 'windowMenu').map((m) => m.role).filter(Boolean);
    expect(win).toContain('minimize');
    // 非 mac 的 role close 自带 Ctrl+W(直接关整窗);关窗口在 File 菜单(⇧Ctrl+W)
    expect(flatten(top).some((m) => m.role === 'close')).toBe(false);
  });

  it('菜单用到的每个 key 三语齐全,zh / ko 不是英文原文', () => {
    const keys = flatten(template(isMac))
      .map((m) => m.label)
      .filter((label): label is string => typeof label === 'string' && label.startsWith('menu.'));
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) {
      expect(en[key as keyof typeof en], key).toBeTruthy();
      expect(zh[key as keyof typeof zh], key).toBeTruthy();
      expect(ko[key as keyof typeof ko], key).toBeTruthy();
      expect(zh[key as keyof typeof zh], key).not.toBe(en[key as keyof typeof en]);
      expect(ko[key as keyof typeof ko], key).not.toBe(en[key as keyof typeof en]);
    }
  });
});

describe('「设置…」菜单项 = 命令 settings.toggle', () => {
  function settingsItem(items: readonly Item[]): Item | undefined {
    return flatten(items).find((m) => m.label === 'menu.app.settings');
  }

  it('mac:在应用菜单里,accelerator = 推送的生效键位(⌘,);点击经 RUN_MENU_COMMAND 发 settings.toggle', () => {
    setMenuKeybindings({ 'settings.toggle': 'meta+,' });
    const top = template(true);
    const appMenu = top[0]!;
    expect(appMenu.label).toBe('Continuo');
    const item = settingsItem(Array.isArray(appMenu.submenu) ? appMenu.submenu : []);
    expect(item?.accelerator).toBe('Command+,');
    const win = new mocks.FakeBrowserWindow();
    item?.click?.(item as never, win as never, {} as never);
    expect(mocks.sendMenuCommand).toHaveBeenCalledWith(win, 'settings.toggle', false);
  });

  it('其它平台:在 File 菜单里', () => {
    setMenuKeybindings({ 'settings.toggle': 'ctrl+,' });
    const file = template(false).find((m) => m.label === 'menu.file.label');
    const item = settingsItem(Array.isArray(file?.submenu) ? file.submenu : []);
    expect(item?.accelerator).toBe('Ctrl+,');
  });

  it('settings.toggle 是菜单命令,命令默认键 mod+,', () => {
    bootCorePlugins();
    expect(MENU_COMMAND_IDS).toContain('settings.toggle');
    expect(coApp.commands.get('settings.toggle')?.hotkey).toBe('mod+,');
  });
});
