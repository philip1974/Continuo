// BDD: workbench-layout-visibility —— 显示 › 外观 子菜单(全屏命令项、状态栏 / 活动栏 / 标签栏勾选)。见同目录 README 第 7 条。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => {
  const focused = { full: false, setFullScreen: vi.fn((v: boolean) => (focused.full = v)), isFullScreen: () => focused.full };
  return { sendMenuCommand: vi.fn(() => true), focused, FakeBrowserWindow: class {} };
});
vi.mock('electron', () => ({
  app: { name: 'Continuo' },
  BrowserWindow: Object.assign(mocks.FakeBrowserWindow, { getFocusedWindow: () => mocks.focused }),
}));
vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand: mocks.sendMenuCommand, runEditUndoRedo: vi.fn() }));

import { appMenuTemplate, type AppMenuActions } from '../../../electron/main/app-menu';
import { setMenuKeybindings } from '../../../electron/main/menu-keybindings';
import { menuCheckedOf, setMenuChecked } from '../../../electron/main/menu-checked';
import { MENU_CHECKBOX_IDS, MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';
import { layoutMenuCheckedState } from '@/shell/menu-commands';
import { canonicalHotkey } from '@/plugins/command-palette/format-hotkey';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

type Item = MenuItemConstructorOptions;
const actions: AppMenuActions = { newWindow: vi.fn(), openFolderInNewWindow: vi.fn(), reloadWindow: vi.fn(), openHelpLink: vi.fn(), showAbout: vi.fn() };
const template = (isMac = true): Item[] => appMenuTemplate(((k: string) => k) as never, actions, isMac);
const sub = (items: readonly Item[], label: string): Item[] => items.find((m) => m.label === label)!.submenu as Item[];
const appearance = (isMac = true): Item[] => sub(sub(template(isMac), 'menu.view.label'), 'menu.view.appearance');
const nonSep = (items: Item[]) => items.filter((m) => m.type !== 'separator');

const IDS = [
  'workbench.action.toggleFullScreen',
  'workbench.action.toggleStatusbarVisibility',
  'workbench.action.toggleActivityBarVisibility',
  'workbench.action.showMultipleEditorTabs',
  'workbench.action.hideEditorTabs',
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  setMenuKeybindings({});
  setMenuChecked({});
  mocks.focused.full = false;
});

describe('显示 › 外观', () => {
  it('在显示菜单「命令面板」之后、编辑器布局之前(VSCode 2_appearance)', () => {
    const view = sub(template(), 'menu.view.label').filter((m) => m.type !== 'separator');
    expect(view.map((m) => m.label).indexOf('menu.view.appearance')).toBe(1);
    expect(view.some((m) => m.role === 'togglefullscreen')).toBe(false);
  });

  it('全屏(命令项,显示生效键位,不抢键)| 状态栏 / 活动栏勾选 | 标签栏 ▸ 多个标签页 / 隐藏', () => {
    // renderer 推送的是归一后的生效键(menu-commands menuKeybindings)
    setMenuKeybindings({ 'workbench.action.toggleFullScreen': canonicalHotkey('ctrl+mod+f', 'mac') });
    const items = appearance();
    expect(items.map((m) => m.type ?? m.id)).toEqual([
      'workbench.action.toggleFullScreen',
      'separator',
      'checkbox',
      'checkbox',
      'separator',
      undefined,
    ]);
    expect(items[0]).toMatchObject({ label: 'menu.view.full_screen', accelerator: 'Command+Control+F', registerAccelerator: false });
    expect(nonSep(items).map((m) => m.id ?? m.label)).toEqual([
      'workbench.action.toggleFullScreen',
      'workbench.action.toggleStatusbarVisibility',
      'workbench.action.toggleActivityBarVisibility',
      'menu.view.tab_bar',
    ]);
    expect((items.at(-1)!.submenu as Item[]).map((m) => [m.id, m.type])).toEqual([
      ['workbench.action.showMultipleEditorTabs', 'checkbox'],
      ['workbench.action.hideEditorTabs', 'checkbox'],
    ]);
  });

  it('Windows / Linux 全屏显示 F11', () => {
    setMenuKeybindings({ 'workbench.action.toggleFullScreen': canonicalHotkey('f11', 'other') });
    expect(appearance(false)[0]!.accelerator).toBe('F11');
  });

  it('点击经 sendMenuCommand 执行命令;没有可用主窗时直接切换获焦窗口全屏', () => {
    const full = appearance()[0]!;
    full.click!(full as never, {} as never, {} as never);
    expect(mocks.sendMenuCommand).toHaveBeenCalledWith({}, 'workbench.action.toggleFullScreen', false);
    expect(mocks.focused.setFullScreen).not.toHaveBeenCalled();
    mocks.sendMenuCommand.mockReturnValueOnce(false);
    full.click!(full as never, {} as never, {} as never);
    expect(mocks.focused.setFullScreen).toHaveBeenCalledWith(true);
  });

  it('勾选状态 = renderer 推送(VSCode toggled 条件)', () => {
    setMenuChecked(layoutMenuCheckedState(false, true, 'none'));
    const items = appearance();
    expect(items.find((m) => m.id === 'workbench.action.toggleStatusbarVisibility')!.checked).toBe(false);
    expect(items.find((m) => m.id === 'workbench.action.toggleActivityBarVisibility')!.checked).toBe(true);
    const tabs = items.at(-1)!.submenu as Item[];
    expect(tabs.map((m) => m.checked)).toEqual([false, true]);
    expect(menuCheckedOf('workbench.action.hideEditorTabs')).toBe(true);
    expect(layoutMenuCheckedState(true, false, 'multiple')).toEqual({
      'workbench.action.toggleStatusbarVisibility': true,
      'workbench.action.toggleActivityBarVisibility': false,
      'workbench.action.showMultipleEditorTabs': true,
      'workbench.action.hideEditorTabs': false,
    });
  });

  it('菜单命令 / 勾选项已登记;标签三语', () => {
    for (const id of IDS) expect(MENU_COMMAND_IDS).toContain(id);
    for (const id of IDS.slice(1)) expect(MENU_CHECKBOX_IDS).toContain(id);
    for (const k of ['menu.view.appearance', 'menu.view.full_screen', 'menu.view.status_bar', 'menu.view.activity_bar', 'menu.view.tab_bar', 'menu.view.tab_bar_multiple', 'menu.view.tab_bar_hidden'] as const) {
      expect(en[k]).toBeTruthy();
      expect(zh[k]).not.toBe(en[k]);
      expect(ko[k]).not.toBe(en[k]);
    }
  });
});
