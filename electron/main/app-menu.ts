// 应用菜单模板(对齐 VSCode mac 菜单栏:应用 / 文件 / 编辑 / 选择 / 显示 / 转到 / 终端 / 窗口 / 帮助,只取关键入口)。标签随界面语言:
// role 项保留 role(系统行为 / 默认快捷键不变)、传 label: t(...)(Electron 的 role 默认标签只有英文)。
// 命令项(MENU_COMMAND_IDS)= renderer 命令:点击经 sendMenuCommand 发给获焦窗口的主窗执行;accelerator 是 renderer 推送的
// 当前生效主键(跟随改键 / 解绑 / 冲突落败,见 menu-keybindings),registerAccelerator: false 只显示不抢键。
// 语言切换 / 键位变化时由 index.ts rebuildAppMenu 整体重建。BDD: src/__tests__/command-discoverability/、src/__tests__/app-menu-bar/
import { app, BrowserWindow, type KeyboardEvent, type MenuItemConstructorOptions } from 'electron';
import { sendMenuCommand } from './lib/menu-command';
import { menuAcceleratorOf } from './menu-keybindings';
import type { MenuCommandId } from '../shared/window-channels';
import type { MainT } from './i18n';
import type { TranslationKey } from '../shared/i18n-locales/en';

/** 菜单里依赖组合根(main/index.ts)的动作:开窗 / 重新加载(含脏确认 + flush)。 */
export interface AppMenuActions {
  readonly newWindow: () => void;
  readonly openFolderInNewWindow: () => void;
  readonly reloadWindow: (win: BrowserWindow, ignoreCache: boolean) => void;
}

/** 菜单命令 → 显示的 accelerator(缺省取 renderer 推送的生效键位)。 */
export type MenuAcceleratorOf = (id: MenuCommandId) => string | undefined;

type Item = MenuItemConstructorOptions;
const SEPARATOR: Item = { type: 'separator' };

export function appMenuTemplate(
  t: MainT,
  actions: AppMenuActions,
  isMac: boolean = process.platform === 'darwin',
  acceleratorOf: MenuAcceleratorOf = (id) => menuAcceleratorOf(id, isMac),
): Item[] {
  const name = app.name;
  // 命令项:点击 = 在获焦窗口执行命令(popout 子窗 → 打开它的主窗执行,命令作用于该子窗);没有可用主窗 → fallback。
  // triggeredByAccelerator(macOS 上 registerAccelerator: false 无效,按键未被 renderer 处理时仍会触发)→ viaKey,renderer
  // 按命令的上下文条件重新判定(VSCode:accelerator 触发的菜单项交给渲染进程按键位重新解析)。
  const command = (id: MenuCommandId, labelKey: TranslationKey, fallback?: () => void): Item => {
    const accelerator = acceleratorOf(id);
    return {
      // id = 命令 id(同一菜单内唯一;e2e 钩子据此找菜单项)
      id,
      label: t(labelKey),
      ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
      click: (_item, win, event: KeyboardEvent) => {
        if (!sendMenuCommand(win, id, event?.triggeredByAccelerator === true)) fallback?.();
      },
    };
  };

  // 首选项(VSCode:macOS 在应用菜单 Code → Preferences,其它平台 File → Preferences):设置… = settings.toggle(⌘,)、
  // 键盘快捷方式 = 打开设置的快捷键页。
  const preferencesItem: Item = {
    label: t('menu.app.preferences'),
    submenu: [
      command('settings.toggle', 'menu.app.settings'),
      command('workbench.action.openGlobalKeybindings', 'menu.app.keyboard_shortcuts'),
    ],
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
    command('workbench.action.files.openFolder', 'menu.file.open_folder', () => actions.openFolderInNewWindow()),
    {
      label: t('menu.file.open_folder_in_new_window'),
      click: () => actions.openFolderInNewWindow(),
    },
    command('workbench.action.openRecent', 'menu.file.open_recent'),
    SEPARATOR,
    command('workbench.action.files.saveAll', 'menu.file.save_all'),
    // 其它平台没有应用菜单:首选项放 File 菜单(VSCode:File → Preferences)。
    ...(isMac ? [] : [SEPARATOR, preferencesItem]),
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

  // 原生编辑项保留 role(输入框 / 终端 / 编辑器里由系统分发);其后是 VSCode 编辑菜单的查找 / 注释(作用于获焦窗口的活动文本编辑器,
  // 没有文本编辑器 → 静默,与命令面板一致)。
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
        ] satisfies Item[])
      : ([
          { role: 'delete', label: t('menu.edit.delete') },
          SEPARATOR,
          { role: 'selectAll', label: t('menu.edit.select_all') },
        ] satisfies Item[])),
    SEPARATOR,
    command('actions.find', 'menu.edit.find'),
    command('editor.action.startFindReplaceAction', 'menu.edit.replace'),
    SEPARATOR,
    command('workbench.action.findInFiles', 'menu.edit.find_in_files'),
    SEPARATOR,
    command('editor.action.commentLine', 'menu.edit.toggle_line_comment'),
    command('editor.action.blockComment', 'menu.edit.toggle_block_comment'),
    ...(isMac
      ? ([
          SEPARATOR,
          {
            label: t('menu.edit.speech'),
            submenu: [
              { role: 'startSpeaking', label: t('menu.edit.start_speaking') },
              { role: 'stopSpeaking', label: t('menu.edit.stop_speaking') },
            ],
          },
        ] satisfies Item[])
      : []),
  ];

  // 选择(VSCode Selection 菜单的精简版):作用于获焦窗口的活动文本编辑器。
  const selectionSubmenu: Item[] = [
    { role: 'selectAll', label: t('menu.edit.select_all') },
    command('expandLineSelection', 'menu.selection.expand_line'),
    SEPARATOR,
    command('editor.action.copyLinesUpAction', 'menu.selection.copy_line_up'),
    command('editor.action.copyLinesDownAction', 'menu.selection.copy_line_down'),
    command('editor.action.moveLinesUpAction', 'menu.selection.move_line_up'),
    command('editor.action.moveLinesDownAction', 'menu.selection.move_line_down'),
    SEPARATOR,
    command('editor.action.insertCursorAbove', 'menu.selection.add_cursor_above'),
    command('editor.action.insertCursorBelow', 'menu.selection.add_cursor_below'),
    command('editor.action.addSelectionToNextFindMatch', 'menu.selection.add_next_occurrence'),
    command('editor.action.selectHighlights', 'menu.selection.select_all_occurrences'),
  ];

  // 同 Electron 默认 viewMenu,只把 reload / forceReload 换成先走脏确认 + flush 的自定义项(role 项的 click 会被 role
  // 动作抢先执行,无法拦截)。
  // 前半是 VSCode 显示菜单的命令项(命令面板 / 各视图 / 侧栏 / 自动换行)。
  const viewSubmenu: Item[] = [
    command('workbench.action.showCommands', 'menu.view.command_palette'),
    SEPARATOR,
    command('workbench.view.explorer', 'menu.view.explorer'),
    command('workbench.action.findInFiles', 'menu.view.search'),
    command('workbench.action.terminal.toggleTerminal', 'menu.view.terminal'),
    command('workbench.view.output', 'menu.view.output'),
    SEPARATOR,
    command('explorer.toggleSidebar', 'menu.view.toggle_sidebar'),
    command('editor.action.toggleWordWrap', 'menu.view.word_wrap'),
    SEPARATOR,
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

  const goSubmenu: Item[] = [
    command('workbench.action.navigateBack', 'menu.go.back'),
    command('workbench.action.navigateForward', 'menu.go.forward'),
    SEPARATOR,
    command('workbench.action.quickOpen', 'menu.go.go_to_file'),
    command('workbench.action.gotoLine', 'menu.go.go_to_line'),
    SEPARATOR,
    command('workbench.action.nextEditor', 'menu.go.next_editor'),
    command('workbench.action.previousEditor', 'menu.go.previous_editor'),
  ];

  const terminalSubmenu: Item[] = [
    command('terminal.new', 'menu.terminal.new_terminal'),
    command('workbench.action.terminal.toggleTerminal', 'menu.terminal.toggle_terminal'),
  ];

  // 帮助:显示所有命令、键盘快捷方式参考(VSCode 打开 PDF 速查表;这里打开设置的快捷键页)。
  const helpSubmenu: Item[] = [
    command('workbench.action.showCommands', 'menu.help.show_all_commands'),
    command('workbench.action.openGlobalKeybindings', 'menu.help.keyboard_shortcuts_reference'),
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
              preferencesItem,
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
    { label: t('menu.selection.label'), submenu: selectionSubmenu },
    { role: 'viewMenu', label: t('menu.view.label'), submenu: viewSubmenu },
    { label: t('menu.go.label'), submenu: goSubmenu },
    { label: t('menu.terminal.label'), submenu: terminalSubmenu },
    { role: 'windowMenu', label: t('menu.window.label'), submenu: windowSubmenu },
    // role help:macOS 帮助菜单带系统搜索框
    { role: 'help', label: t('menu.help.label'), submenu: helpSubmenu },
  ];
}
