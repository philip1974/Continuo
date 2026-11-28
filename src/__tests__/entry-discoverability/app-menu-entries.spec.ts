// @vitest-environment node
// BDD: entry-discoverability 第 1 / 3 / 5 条 —— 应用菜单补高频命令入口(文件 / 显示 / 转到)、帮助菜单外链与 Windows / Linux「关于」。
// 见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';

const mocks = vi.hoisted(() => ({
  sendMenuCommand: vi.fn(() => true),
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1 })),
  writeText: vi.fn(),
  openExternal: vi.fn(async (_url: string) => {}),
  FakeBrowserWindow: class FakeBrowserWindow {
    isDestroyed(): boolean {
      return false;
    }
  },
}));

vi.mock('electron', () => ({
  app: { name: 'continuo', getVersion: () => '9.8.7' },
  BrowserWindow: mocks.FakeBrowserWindow,
  dialog: { showMessageBox: mocks.showMessageBox },
  clipboard: { writeText: mocks.writeText },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('../../../electron/main/lib/menu-command', () => ({ sendMenuCommand: mocks.sendMenuCommand, runEditUndoRedo: vi.fn() }));

import { appMenuTemplate, type AppMenuActions } from '../../../electron/main/app-menu';
import { setMenuKeybindings } from '../../../electron/main/menu-keybindings';
import { HELP_LINKS, aboutDetail, isHttpsUrl, openHelpLink, showAboutDialog } from '../../../electron/main/help-links';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';

type Item = MenuItemConstructorOptions;

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}${JSON.stringify(params)}` : key;
const actions: AppMenuActions = {
  newWindow: vi.fn(),
  openFolderInNewWindow: vi.fn(),
  reloadWindow: vi.fn(),
  openHelpLink: vi.fn(),
  showAbout: vi.fn(),
};

const template = (isMac: boolean): Item[] => appMenuTemplate(t as never, actions, isMac);
const flatten = (items: readonly Item[]): Item[] =>
  items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
const submenu = (items: readonly Item[], label: string): Item[] => {
  const menu = items.find((m) => m.label === label);
  if (!menu || !Array.isArray(menu.submenu)) throw new Error(`missing ${label}`);
  return menu.submenu;
};
const byId = (items: readonly Item[], id: string): Item | undefined => flatten(items).find((m) => m.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  setMenuKeybindings({});
});

describe('文件 / 显示 / 转到菜单的高频命令(命令已注册,键位跟随生效绑定)', () => {
  it.each([
    ['menu.file.label', 'workbench.action.closeActiveEditor', 'meta+w', 'Command+W'],
    ['menu.file.label', 'workbench.action.reopenClosedEditor', 'meta+shift+t', 'Command+Shift+T'],
    ['menu.file.label', 'workbench.action.files.revert', null, undefined],
    ['menu.file.label', 'workbench.action.closeFolder', null, undefined],
    ['menu.view.label', 'workbench.view.debug', 'meta+shift+d', 'Command+Shift+D'],
    ['menu.view.label', 'workbench.action.splitEditor', 'meta+\\', 'Command+\\'],
    ['menu.go.label', 'editor.action.revealDefinition', 'f12', 'F12'],
    ['menu.go.label', 'editor.action.jumpToBracket', 'meta+shift+\\', 'Command+Shift+\\'],
    ['menu.go.label', 'editor.action.marker.nextInFiles', 'f8', 'F8'],
    ['menu.go.label', 'workbench.action.focusSecondEditorGroup', 'meta+2', 'Command+2'],
  ] as const)('%s → %s(%s → %s)', (menu, id, hotkey, accelerator) => {
    setMenuKeybindings({ [id]: hotkey });
    const item = byId(submenu(template(true), menu), id);
    expect(item, id).toBeDefined();
    expect(item!.accelerator).toBe(accelerator);
    item!.click!(item as never, {} as never, {} as never);
    expect(mocks.sendMenuCommand).toHaveBeenLastCalledWith({}, id, false);
  });

  it('关闭编辑器 / 还原文件 / 关闭文件夹在「关闭窗口」之前同一组(VSCode 6_close)', () => {
    const file = submenu(template(true), 'menu.file.label');
    const ids = file.map((m) => m.id ?? m.label ?? m.type);
    const closeWindow = ids.indexOf('menu.file.close_window');
    expect(ids.slice(closeWindow - 4, closeWindow)).toEqual([
      'separator',
      'workbench.action.files.revert',
      'workbench.action.closeActiveEditor',
      'workbench.action.closeFolder',
    ]);
  });

  it('显示 ▸ 编辑器布局 ▸ 向右拆分 / 向下拆分;转到 ▸ 切换组 ▸ 第 1 / 2 / 3 组', () => {
    const view = submenu(template(true), 'menu.view.label');
    expect(submenu(view, 'menu.view.editor_layout').map((m) => m.label)).toEqual(['menu.view.split_right', 'menu.view.split_down']);
    const go = submenu(template(true), 'menu.go.label');
    expect(submenu(go, 'menu.go.switch_group').map((m) => m.label)).toEqual([
      'menu.go.group_1',
      'menu.go.group_2',
      'menu.go.group_3',
      'menu.go.group_4',
      'menu.go.group_5',
    ]);
  });

  it('三语标签照 VSCode 中文语言包', () => {
    expect([zh['menu.file.close_editor'], zh['menu.file.revert'], zh['menu.file.close_folder']]).toEqual(['关闭编辑器', '还原文件', '关闭文件夹']);
    expect([zh['menu.view.run'], zh['menu.go.go_to_bracket'], zh['menu.go.next_problem'], zh['menu.go.switch_group']]).toEqual([
      '运行',
      '转到括号',
      '下一个问题',
      '切换组',
    ]);
    expect(en['menu.file.reopen_closed_editor']).toBe('Reopen Closed Editor');
  });
});

describe('帮助菜单:文档 / 发行说明 / 报告问题 / 关于', () => {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as {
    homepage: string;
    bugs: { url: string };
  };

  it('链接同 package.json 的 homepage / bugs.url,都是 https', () => {
    expect(HELP_LINKS.documentation).toBe(pkg.homepage);
    expect(HELP_LINKS.releaseNotes).toBe(`${pkg.homepage}/releases`);
    expect(HELP_LINKS.reportIssue).toBe(pkg.bugs.url);
    for (const url of Object.values(HELP_LINKS)) expect(isHttpsUrl(url)).toBe(true);
  });

  it('菜单项点击 → openHelpLink(对应链接);顺序 显示所有命令 / 文档 / 发行说明 / 快捷键参考 / 报告问题', () => {
    const help = submenu(template(true), 'menu.help.label').filter((m) => m.type !== 'separator');
    expect(help.map((m) => m.id ?? m.label)).toEqual([
      'workbench.action.showCommands',
      'menu.help.documentation',
      'menu.help.release_notes',
      'workbench.action.openGlobalKeybindings',
      'menu.help.report_issue',
    ]);
    for (const [label, url] of [
      ['menu.help.documentation', HELP_LINKS.documentation],
      ['menu.help.release_notes', HELP_LINKS.releaseNotes],
      ['menu.help.report_issue', HELP_LINKS.reportIssue],
    ] as const) {
      const item = help.find((m) => m.label === label)!;
      item.click!(item as never, undefined as never, {} as never);
      expect(actions.openHelpLink).toHaveBeenLastCalledWith(url);
    }
  });

  it('openHelpLink 只打开 https(其它 scheme / 非法 URL 不交给系统)', () => {
    expect(openHelpLink('https://example.com/x')).toBe(true);
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/x');
    for (const bad of ['http://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect(openHelpLink(bad)).toBe(false);
    }
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  });

  it('Windows / Linux:帮助菜单末尾「关于 Continuo」→ showAbout(获焦窗口);macOS 帮助菜单没有(在应用菜单 role about)', () => {
    const other = submenu(template(false), 'menu.help.label');
    const about = other.at(-1)!;
    expect(about.label).toBe('menu.app.about{"name":"Continuo"}');
    expect(other.at(-2)?.type).toBe('separator');
    const win = new mocks.FakeBrowserWindow();
    about.click!(about as never, win as never, {} as never);
    expect(actions.showAbout).toHaveBeenLastCalledWith(win);
    about.click!(about as never, undefined as never, {} as never);
    expect(actions.showAbout).toHaveBeenLastCalledWith(undefined);
    const mac = template(true);
    expect(flatten(submenu(mac, 'menu.help.label')).some((m) => String(m.label).startsWith('menu.app.about'))).toBe(false);
    expect(submenu(mac, 'continuo')[0]?.role).toBe('about');
  });

  it('关于对话框:版本 / Electron / Chromium / Node.js / V8 / OS;「复制」把详情写进剪贴板,「确定」不写', async () => {
    const info = { version: '9.8.7', electron: '45.0.0', chromium: '140.0', node: '22.0.0', v8: '14.0', os: 'Linux x64 6.1' };
    const detail = aboutDetail(t as never, info);
    expect(detail).toContain('"version":"9.8.7"');
    const win = new mocks.FakeBrowserWindow();
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await showAboutDialog(t as never, win as never, info);
    const [parent, options] = mocks.showMessageBox.mock.calls[0]! as [unknown, { message: string; detail: string; buttons: string[] }];
    expect(parent).toBe(win);
    expect(options.message).toBe('Continuo');
    expect(options.detail).toBe(detail);
    expect(options.buttons).toEqual(['menu.help.about_copy', 'menu.help.about_ok']);
    expect(mocks.writeText).toHaveBeenCalledWith(detail);
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    await showAboutDialog(t as never, undefined, info);
    expect(mocks.showMessageBox.mock.calls[1]).toHaveLength(1); // 无窗口 → 独立对话框
    expect(mocks.writeText).toHaveBeenCalledTimes(1);
  });

  it('关于详情三语:zh「版本：…」含真实版本号', () => {
    const zhT = (key: string, params: Record<string, string>) =>
      (zh as Record<string, string>)[key]!.replace(/\{(\w+)\}/g, (_m, k: string) => params[k] ?? '');
    const text = aboutDetail(zhT as never, { version: '0.2.15', electron: 'e', chromium: 'c', node: 'n', v8: 'v', os: 'o' });
    expect(text.split('\n')[0]).toBe('版本：0.2.15');
    expect(text.split('\n')).toHaveLength(6);
  });
});
