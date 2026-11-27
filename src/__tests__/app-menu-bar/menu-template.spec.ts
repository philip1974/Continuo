// BDD: app-menu-bar 第 1 / 2 条 —— 菜单结构对齐 VSCode、三语标签、命令项 accelerator 跟随推送的生效键位且只显示
//(registerAccelerator: false)、点击经 sendMenuCommand 发往获焦窗口(accelerator 触发带 viaKey)。见同目录 README。
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
import { setMenuKeybindings } from '../../../electron/main/menu-keybindings';
import { MENU_COMMAND_IDS } from '../../../electron/shared/window-channels';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';

type Item = MenuItemConstructorOptions;

const t = (key: string): string => key;
const actions: AppMenuActions = { newWindow: vi.fn(), openFolderInNewWindow: vi.fn(), reloadWindow: vi.fn() };

function template(isMac: boolean, acc?: (id: string) => string | undefined): Item[] {
  return appMenuTemplate(t as never, actions, isMac, acc);
}

function flatten(items: readonly Item[]): Item[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

function submenu(items: readonly Item[], label: string): Item[] {
  const menu = items.find((m) => m.label === label);
  if (!menu || !Array.isArray(menu.submenu)) throw new Error(`missing ${label}`);
  return menu.submenu;
}

/** 菜单项点击后发出的命令 id(role / 分隔线 / 子菜单 → undefined)。 */
function commandOf(item: Item): string | undefined {
  if (!item.click) return undefined;
  mocks.sendMenuCommand.mockClear();
  // 普通对象当窗口:关闭窗口 / 重新加载项只认 BrowserWindow,不会动
  item.click(item as never, {} as never, {} as never);
  return (mocks.sendMenuCommand.mock.calls[0] as unknown[] | undefined)?.[1] as string | undefined;
}

const commandsOf = (items: readonly Item[]): (string | undefined)[] =>
  items.filter((m) => m.type !== 'separator').map((m) => m.role ?? commandOf(m) ?? m.label);

beforeEach(() => {
  vi.clearAllMocks();
  setMenuKeybindings({});
});

describe('菜单结构(对齐 VSCode mac 菜单栏)', () => {
  it('顶层顺序:应用 / 文件 / 编辑 / 选择 / 显示 / 转到 / 终端 / 窗口 / 帮助(帮助为 role help)', () => {
    const top = template(true);
    expect(top.map((m) => m.label)).toEqual([
      'Continuo',
      'menu.file.label',
      'menu.edit.label',
      'menu.selection.label',
      'menu.view.label',
      'menu.go.label',
      'menu.terminal.label',
      'menu.window.label',
      'menu.help.label',
    ]);
    expect(top.at(-1)?.role).toBe('help');
    // 其它平台没有应用菜单
    expect(template(false)[0]?.label).toBe('menu.file.label');
  });

  it('macOS 应用菜单:首选项 ▸ 设置… / 键盘快捷方式;其它平台在文件菜单', () => {
    const prefs = (items: readonly Item[]) => submenu(items, 'menu.app.preferences');
    const mac = template(true);
    expect(commandsOf(prefs(submenu(mac, 'Continuo')))).toEqual(['settings.toggle', 'workbench.action.openGlobalKeybindings']);
    expect(submenu(mac, 'menu.file.label').some((m) => m.label === 'menu.app.preferences')).toBe(false);
    const other = template(false);
    expect(commandsOf(prefs(submenu(other, 'menu.file.label')))).toEqual([
      'settings.toggle',
      'workbench.action.openGlobalKeybindings',
    ]);
  });

  it('文件:打开最近的文件夹… / 全部保存', () => {
    const file = commandsOf(submenu(template(true), 'menu.file.label'));
    expect(file).toEqual([
      'menu.file.new_window',
      'workbench.action.files.openFolder',
      'menu.file.open_folder_in_new_window',
      'workbench.action.openRecent',
      'workbench.action.files.saveAll',
      'menu.file.close_window',
    ]);
  });

  it('编辑:原生 role 项不变,其后 查找 / 替换 / 在文件中查找 / 切换行注释 / 块注释', () => {
    const edit = commandsOf(submenu(template(true), 'menu.edit.label'));
    expect(edit).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
      'actions.find',
      'editor.action.startFindReplaceAction',
      'workbench.action.findInFiles',
      'editor.action.commentLine',
      'editor.action.blockComment',
      'menu.edit.speech',
    ]);
  });

  it('选择 / 显示 / 转到 / 终端 / 帮助的命令项', () => {
    const top = template(true);
    expect(commandsOf(submenu(top, 'menu.selection.label'))).toEqual([
      'selectAll',
      'expandLineSelection',
      'editor.action.copyLinesUpAction',
      'editor.action.copyLinesDownAction',
      'editor.action.moveLinesUpAction',
      'editor.action.moveLinesDownAction',
      'editor.action.insertCursorAbove',
      'editor.action.insertCursorBelow',
      'editor.action.addSelectionToNextFindMatch',
      'editor.action.selectHighlights',
    ]);
    expect(commandsOf(submenu(top, 'menu.view.label')).slice(0, 7)).toEqual([
      'workbench.action.showCommands',
      'workbench.view.explorer',
      'workbench.action.findInFiles',
      'workbench.action.terminal.toggleTerminal',
      'workbench.view.output',
      'explorer.toggleSidebar',
      'editor.action.toggleWordWrap',
    ]);
    // 外观相关保留
    expect(commandsOf(submenu(top, 'menu.view.label')).slice(7)).toEqual([
      'menu.view.reload',
      'menu.view.force_reload',
      'toggleDevTools',
      'workbench.action.zoomReset',
      'workbench.action.zoomIn',
      'workbench.action.zoomOut',
      'togglefullscreen',
    ]);
    expect(commandsOf(submenu(top, 'menu.go.label'))).toEqual([
      'workbench.action.navigateBack',
      'workbench.action.navigateForward',
      'workbench.action.quickOpen',
      'workbench.action.gotoLine',
      'workbench.action.nextEditor',
      'workbench.action.previousEditor',
    ]);
    expect(commandsOf(submenu(top, 'menu.terminal.label'))).toEqual([
      'terminal.new',
      'workbench.action.terminal.toggleTerminal',
    ]);
    expect(commandsOf(submenu(top, 'menu.help.label'))).toEqual([
      'workbench.action.showCommands',
      'workbench.action.openGlobalKeybindings',
    ]);
  });

  it('菜单用到的命令都已登记为菜单命令、并在命令注册表里注册', () => {
    bootCorePlugins();
    const used = new Set(flatten(template(true)).map(commandOf).filter((id): id is string => id !== undefined));
    expect([...used].sort()).toEqual([...MENU_COMMAND_IDS].sort());
    for (const id of MENU_COMMAND_IDS) expect(coApp.commands.get(id), id).toBeDefined();
  });

  it.each([true, false])('三语标签齐全(isMac=%s):每个 menu.* key 在 en / zh / ko 都有,zh / ko 不是英文原文', (isMac) => {
    const keys = flatten(template(isMac))
      .map((m) => m.label)
      .filter((label): label is string => typeof label === 'string' && label.startsWith('menu.'));
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      expect(en[key as keyof typeof en], key).toBeTruthy();
      expect(zh[key as keyof typeof zh], key).toBeTruthy();
      expect(ko[key as keyof typeof ko], key).toBeTruthy();
      expect(zh[key as keyof typeof zh], key).not.toBe(en[key as keyof typeof en]);
      expect(ko[key as keyof typeof ko], key).not.toBe(en[key as keyof typeof en]);
    }
  });
});

describe('命令项的 accelerator:跟随推送的生效键位,只显示', () => {
  const find = (items: readonly Item[], id: string): Item => flatten(items).find((m) => commandOf(m) === id)!;

  it('推送的键位 → accelerator + registerAccelerator: false;改键后重建跟随;解绑 / 落败(null)→ 无 accelerator', () => {
    setMenuKeybindings({ 'editor.action.commentLine': 'meta+/', 'workbench.action.files.saveAll': 'meta+alt+s' });
    let top = template(true);
    expect(find(top, 'editor.action.commentLine')).toMatchObject({ accelerator: 'Command+/', registerAccelerator: false });
    expect(find(top, 'workbench.action.files.saveAll')).toMatchObject({ accelerator: 'Command+Alt+S', registerAccelerator: false });

    setMenuKeybindings({ 'editor.action.commentLine': 'ctrl+shift+c', 'workbench.action.files.saveAll': null });
    top = template(true);
    expect(find(top, 'editor.action.commentLine').accelerator).toBe('Control+Shift+C');
    expect(find(top, 'workbench.action.files.saveAll').accelerator).toBeUndefined();
    expect(find(top, 'workbench.action.files.saveAll').registerAccelerator).toBeUndefined();
  });

  it('Windows / Linux:meta → Super,ctrl → Ctrl', () => {
    setMenuKeybindings({ 'workbench.action.files.openFolder': 'ctrl+o', 'terminal.new': 'meta+t' });
    const top = template(false);
    expect(find(top, 'workbench.action.files.openFolder').accelerator).toBe('Ctrl+O');
    expect(find(top, 'terminal.new').accelerator).toBe('Super+T');
  });

  it('命令项都 registerAccelerator: false;非命令项(新建窗口 / 重新加载 / 关闭窗口)保留原 accelerator', () => {
    const all = Object.fromEntries(MENU_COMMAND_IDS.map((id) => [id, 'meta+f12']));
    setMenuKeybindings(all);
    const items = flatten(template(true));
    for (const item of items.filter((m) => commandOf(m) !== undefined)) {
      expect(item.registerAccelerator, String(item.label)).toBe(false);
    }
    const byLabel = (l: string) => items.find((m) => m.label === l)!;
    expect(byLabel('menu.file.new_window').accelerator).toBe('CmdOrCtrl+Shift+N');
    expect(byLabel('menu.view.reload').accelerator).toBe('CmdOrCtrl+R');
    expect(byLabel('menu.file.close_window').accelerator).toBe('Shift+CmdOrCtrl+W');
  });
});

describe('命令项点击 → sendMenuCommand(获焦窗口, id, viaKey)', () => {
  const item = (id: string): Item => flatten(template(true)).find((m) => commandOf(m) === id)!;

  it('鼠标点击 viaKey=false;accelerator 触发(triggeredByAccelerator)viaKey=true', () => {
    const win = new mocks.FakeBrowserWindow();
    const it1 = item('editor.action.commentLine');
    mocks.sendMenuCommand.mockClear();
    it1.click!(it1 as never, win as never, { triggeredByAccelerator: false } as never);
    expect(mocks.sendMenuCommand).toHaveBeenLastCalledWith(win, 'editor.action.commentLine', false);
    it1.click!(it1 as never, win as never, { triggeredByAccelerator: true } as never);
    expect(mocks.sendMenuCommand).toHaveBeenLastCalledWith(win, 'editor.action.commentLine', true);
  });

  it('打开文件夹:没有可用主窗 → 在新窗口打开;其它命令项没有兜底', () => {
    const open = item('workbench.action.files.openFolder');
    const saveAll = item('workbench.action.files.saveAll');
    vi.mocked(actions.openFolderInNewWindow).mockClear();
    mocks.sendMenuCommand.mockReturnValueOnce(false);
    open.click!(open as never, undefined as never, {} as never);
    expect(actions.openFolderInNewWindow).toHaveBeenCalledTimes(1);
    mocks.sendMenuCommand.mockReturnValueOnce(false);
    saveAll.click!(saveAll as never, undefined as never, {} as never);
    expect(actions.openFolderInNewWindow).toHaveBeenCalledTimes(1);
  });
});
