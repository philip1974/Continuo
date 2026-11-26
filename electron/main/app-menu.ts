// 应用菜单模板。标签随界面语言:role 项保留 role(系统行为 / 默认快捷键不变)、传 label: t(...)(Electron 的 role 默认标签
// 只有英文);Edit / View / Window 用显式子项。应用菜单(macOS;其它平台在 File 菜单)有「设置… ⌘,」= 命令 settings.toggle。
// 语言切换时由 index.ts rebuildAppMenu 整体重建。BDD: src/__tests__/command-discoverability/
import { app, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { sendMenuCommand } from './lib/menu-command';
import { MENU_COMMANDS, type MenuCommandId } from '../shared/window-channels';
import type { MainT } from './i18n';

/** 菜单里依赖组合根(main/index.ts)的动作:开窗 / 重新加载(含脏确认 + flush)。 */
export interface AppMenuActions {
  readonly newWindow: () => void;
  readonly openFolderInNewWindow: () => void;
  readonly reloadWindow: (win: BrowserWindow, ignoreCache: boolean) => void;
}

const OPEN_FOLDER_MENU_COMMAND: MenuCommandId = 'workbench.action.files.openFolder';
const SETTINGS_MENU_COMMAND: MenuCommandId = 'settings.toggle';

type Item = MenuItemConstructorOptions;
const SEPARATOR: Item = { type: 'separator' };

export function appMenuTemplate(
  t: MainT,
  actions: AppMenuActions,
  isMac: boolean = process.platform === 'darwin',
): Item[] {
  const name = app.name;
  // 「设置…」即 renderer 命令 settings.toggle(⌘,):发给目标主窗(popout 子窗 → 打开它的主窗);没有主窗则无操作。
  const settingsItem: Item = {
    label: t('menu.app.settings'),
    accelerator: MENU_COMMANDS[SETTINGS_MENU_COMMAND],
    click: (_item, win) => {
      sendMenuCommand(win, SETTINGS_MENU_COMMAND);
    },
  };

  const fileSubmenu: Item[] = [
    {
      label: t('menu.file.new_window'),
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => actions.newWindow(),
    },
    SEPARATOR,
    // 打开文件夹(VSCode 文件菜单同款 ⌘O):即 renderer 命令 workbench.action.files.openFolder(在当前窗口切换工作区,
    // 单飞 / 失败提示 / 焦点交文件树都在命令里)。没有可用主窗(mac 关光窗口)→ 选定后在新窗口打开。
    {
      label: t('menu.file.open_folder'),
      accelerator: MENU_COMMANDS[OPEN_FOLDER_MENU_COMMAND],
      click: (_item, win) => {
        if (!sendMenuCommand(win, OPEN_FOLDER_MENU_COMMAND)) actions.openFolderInNewWindow();
      },
    },
    {
      label: t('menu.file.open_folder_in_new_window'),
      click: () => actions.openFolderInNewWindow(),
    },
    // 其它平台没有应用菜单:「设置…」放 File 菜单(VSCode:File → Preferences → Settings)。
    ...(isMac ? [] : [SEPARATOR, settingsItem]),
    SEPARATOR,
    // 关窗口 = ⇧⌘W / Ctrl+Shift+W(对齐 VSCode workbench.action.closeWindow)。⌘W / Ctrl+W 归 renderer 的
    // 「关闭编辑器」命令(workbench.action.closeActiveEditor:关当前文件 tab / 面板,无可关的才关窗口)。
    // 不用 mac 的 { role: 'close' }:它自带 ⌘W,一按直接关整个窗口并杀掉窗内全部终端。
    // win.close() 触发 'close' → 关窗脏确认;win 是聚焦窗口(含 popout 子窗)。
    {
      label: t('menu.file.close_window'),
      accelerator: 'Shift+CmdOrCtrl+W',
      click: (_item, win) => {
        if (win instanceof BrowserWindow) win.close();
      },
    },
    ...(isMac ? [] : [{ role: 'quit', label: t('menu.app.exit') } satisfies Item]),
  ];

  const editSubmenu: Item[] = [
    { role: 'undo', label: t('menu.edit.undo') },
    { role: 'redo', label: t('menu.edit.redo') },
    SEPARATOR,
    { role: 'cut', label: t('menu.edit.cut') },
    { role: 'copy', label: t('menu.edit.copy') },
    { role: 'paste', label: t('menu.edit.paste') },
    ...(isMac
      ? ([
          { role: 'pasteAndMatchStyle', label: t('menu.edit.paste_and_match_style') },
          { role: 'delete', label: t('menu.edit.delete') },
          { role: 'selectAll', label: t('menu.edit.select_all') },
          SEPARATOR,
          {
            label: t('menu.edit.speech'),
            submenu: [
              { role: 'startSpeaking', label: t('menu.edit.start_speaking') },
              { role: 'stopSpeaking', label: t('menu.edit.stop_speaking') },
            ],
          },
        ] satisfies Item[])
      : ([
          { role: 'delete', label: t('menu.edit.delete') },
          SEPARATOR,
          { role: 'selectAll', label: t('menu.edit.select_all') },
        ] satisfies Item[])),
  ];

  // 同 Electron 默认 viewMenu,只把 reload / forceReload 换成先走脏确认 + flush 的自定义项(role 项的 click 会被 role
  // 动作抢先执行,无法拦截)。
  const viewSubmenu: Item[] = [
    {
      label: t('menu.view.reload'),
      accelerator: 'CmdOrCtrl+R',
      click: (_item, win) => {
        if (win instanceof BrowserWindow) actions.reloadWindow(win, false);
      },
    },
    {
      label: t('menu.view.force_reload'),
      accelerator: 'Shift+CmdOrCtrl+R',
      click: (_item, win) => {
        if (win instanceof BrowserWindow) actions.reloadWindow(win, true);
      },
    },
    { role: 'toggleDevTools', label: t('menu.view.toggle_dev_tools') },
    SEPARATOR,
    { role: 'resetZoom', label: t('menu.view.reset_zoom') },
    { role: 'zoomIn', label: t('menu.view.zoom_in') },
    { role: 'zoomOut', label: t('menu.view.zoom_out') },
    SEPARATOR,
    { role: 'togglefullscreen', label: t('menu.view.toggle_full_screen') },
  ];

  // 同 Electron 默认 windowMenu;其它平台不带 role close(其 Ctrl+W 直接关整窗,关窗口在 File 菜单 ⇧Ctrl+W)。
  const windowSubmenu: Item[] = [
    { role: 'minimize', label: t('menu.window.minimize') },
    ...(isMac
      ? ([
          { role: 'zoom', label: t('menu.window.zoom') },
          SEPARATOR,
          { role: 'front', label: t('menu.window.front') },
        ] satisfies Item[])
      : []),
  ];

  return [
    ...(isMac
      ? ([
          {
            label: name,
            submenu: [
              { role: 'about', label: t('menu.app.about', { name }) },
              SEPARATOR,
              settingsItem,
              SEPARATOR,
              { role: 'services', label: t('menu.app.services') },
              SEPARATOR,
              { role: 'hide', label: t('menu.app.hide', { name }) },
              { role: 'hideOthers', label: t('menu.app.hide_others') },
              { role: 'unhide', label: t('menu.app.show_all') },
              SEPARATOR,
              { role: 'quit', label: t('menu.app.quit', { name }) },
            ],
          },
        ] satisfies Item[])
      : []),
    { label: t('menu.file.label'), submenu: fileSubmenu },
    { role: 'editMenu', label: t('menu.edit.label'), submenu: editSubmenu },
    { role: 'viewMenu', label: t('menu.view.label'), submenu: viewSubmenu },
    { role: 'windowMenu', label: t('menu.window.label'), submenu: windowSubmenu },
  ];
}
