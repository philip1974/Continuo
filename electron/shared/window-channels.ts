// Window IPC 通道(多窗口支持,issue #23 Phase 1)。
// renderer 调 coApi.window.create 在已有 main process 内开新主窗口,可选携带
// workspace 路径(注入 query string,renderer 启动时优先用)。

import type { z } from 'zod';
import type { WindowCreateInputSchema } from './window-create-schema';

export const WINDOW_CHANNELS = {
  CREATE: 'window:create',
  /**
   * renderer 在 workspace.root 变化时调 → main 维护 windowId→root 映射,
   * 供 MCP agent terminal_create_session 的默认 cwd 解析使用。
   */
  NOTIFY_ROOT: 'window:notify-root',
  /**
   * renderer 要在本窗口打开文件夹(最近打开 / 打开文件夹… / 拖入文件夹)前先问 main:该文件夹已在**别的**主窗口打开
   * → main 聚焦那个窗口并返回 true,调用方不再改本窗口的 root(VSCode 同);否则 false,照常切换。payload `{ root }`。
   */
  FOCUS_WORKSPACE_WINDOW: 'window:focus-workspace-window',
  /**
   * 设置项「启动时恢复所有窗口」(VSCode window.restoreWindows)变化时 renderer 推送 `{ enabled }` → main 写入 explorer.json
   * 顶层 restoreAllWindowsOnLaunch(启动恢复在任何 renderer 之前读它)。
   */
  SET_RESTORE_WINDOWS: 'window:set-restore-windows',
  /**
   * 设置项「缩放级别」(VSCode window.zoomLevel)→ main(payload `{ level }`):夹到 [-8, 8] 后立即套用到所有窗口(主窗 +
   * popout),并缓存到 userData,冷启动首窗即用。BDD: src/__tests__/window-zoom/
   */
  SET_ZOOM_LEVEL: 'window:set-zoom-level',
  /**
   * renderer 解析出的主题(light / dark)变化时调 → main 记住最近主题,把所有窗口的 backgroundColor 改为对应
   * 画布色,之后新建的窗口 / popout 也用它(否则亮色用户开窗 / 缩放时未绘制区闪深色)。
   */
  NOTIFY_THEME: 'window:notify-theme',
  /**
   * 关闭发起方所在窗口(⌘W「关闭编辑器」已无可关面板时,对齐 VSCode)。main 调 win.close() 走关窗脏确认;
   * 不用 renderer 的 window.close()(不经 BrowserWindow 'close' 事件,会绕过脏确认)。
   */
  CLOSE: 'window:close',
  /**
   * 激活发起方所在窗口(BrowserWindow.focus)。popout 子窗获焦时从它触发的命令在主窗打开面板 / 选择器(⇧⌘F 搜索、⌘, 设置、
   * 新终端…)→ 主窗 renderer 请求激活自己,系统焦点随之进主窗(VSCode 同:辅助窗口里 ⇧⌘F 打开主窗的搜索视图并聚焦主窗)。
   * renderer 的 window.focus() 无用户激活时不激活窗口,故经 main。BDD: src/__tests__/popout-picker/
   */
  FOCUS: 'window:focus',
  /**
   * 重启应用(插件安装后「立即重启」)。main 走与 ⌘Q 相同的退出流程(各窗口脏文件确认 / flush / 清理),全部通过后
   * app.relaunch() 再退出;用户取消 → 不退出也不重启。
   */
  RELAUNCH_APP: 'window:relaunch-app',
  /**
   * main → renderer:应用菜单里「即某条命令」的菜单项被点(或按其 accelerator)→ 请求目标主窗执行该命令(payload
   * MenuCommandPayload,仅限 MENU_COMMAND_IDS 登记的 id)。popout 子窗聚焦时发给打开它的主窗。
   */
  RUN_MENU_COMMAND: 'window:run-menu-command',
  /**
   * main → renderer:点了应用菜单「编辑 → 撤销 / 重做」(鼠标点击;按键触发的直接走原生撤销)。payload EditUndoRedoPayload。
   * renderer 按焦点分派(VSCode UndoCommand 多实现):资源管理器文件树聚焦 → 撤销 / 重做文件操作;否则请 main 对获焦窗口做原生
   * 撤销 / 重做(window:view-action 'undo' / 'redo',编辑器 / 输入框 / 终端照旧)。popout 子窗获焦时发给打开它的主窗。
   * BDD: src/__tests__/app-menu-bar/
   */
  EDIT_UNDO_REDO: 'window:edit-undo-redo',
  /**
   * renderer → main:菜单命令当前生效的主键(`{ keybindings: { [id]: 归一后的 hotkey | null } }`,跟随改键 / 解绑 / 冲突落败)。
   * main 换算成 accelerator 只作显示,菜单随之重建。BDD: src/__tests__/app-menu-bar/
   */
  SET_MENU_KEYBINDINGS: 'window:set-menu-keybindings',
  /**
   * renderer → main:勾选类菜单项的勾选状态(`{ checked: { [id]: boolean } }`,仅限 MENU_CHECKBOX_IDS;如 文件 → 自动保存 =
   * files.autoSave ≠ off)。有变化才重建菜单。BDD: src/__tests__/files-auto-save/
   */
  SET_MENU_CHECKED: 'window:set-menu-checked',
  /**
   * 命令面板里的「重新加载窗口 / 切换全屏」(应用菜单 View 同款动作,payload `{ action, popoutName? }`,
   * 仅限 WINDOW_VIEW_ACTIONS):main 作用于发起方所在窗口;reload 走与菜单 ⌘R 相同的脏确认 + flush。带 popoutName
   *(在 dockview popout 子窗里触发:子窗的 window.open 名)→ 作用于发起方打开的那个子窗。
   */
  VIEW_ACTION: 'window:view-action',
  /**
   * 切换窗口(workbench.action.switchWindow)的列表:各主窗口及其 popout 子窗(VSCode 同列辅助窗口,排在所属主窗之后),标题与
   * 「当前窗口」(发起方所在窗口;带 popoutName → 发起方的那个子窗)。payload `{ popoutName? }`,返回 WindowSwitchEntry[]。
   * BDD: src/__tests__/switch-window/
   */
  LIST_WINDOWS: 'window:list-windows',
  /** 切换窗口选中后聚焦该窗口(payload `{ id }`;只限 LIST_WINDOWS 会列出的窗口,最小化的先还原)。 */
  FOCUS_WINDOW: 'window:focus-window',
  /**
   * renderer → main(invoke,payload `{}`):发起方所在窗口当前是否全屏(返回 boolean)。macOS 标题栏非全屏时给红绿灯留位,
   * 全屏时红绿灯隐藏、不留(VSCode `.monaco-workbench.fullscreen` 隐藏 window-controls-container)。BDD: src/__tests__/title-bar/
   */
  IS_FULL_SCREEN: 'window:is-full-screen',
  /** main → renderer:主窗口进入 / 退出全屏(payload boolean = 现在是否全屏)。 */
  FULL_SCREEN_CHANGED: 'window:full-screen-changed',
} as const;

/** 切换窗口列表的一项(window:list-windows)。 */
export interface WindowSwitchEntry {
  /** BrowserWindow id(window:focus-window 用它)。 */
  readonly id: number;
  readonly title: string;
  /** popout 子窗所属主窗的 id;主窗口 → null。 */
  readonly parentId: number | null;
  /** 发起切换的窗口(列表里标「当前窗口」)。 */
  readonly current: boolean;
}

/** window:view-action 可执行的动作(BDD: src/__tests__/command-discoverability/)。 */
// 放大 / 缩小 / 重置缩放不在此列:它们改设置项 window.zoomLevel(所有窗口统一,见 SET_ZOOM_LEVEL)。
// undo / redo:应用菜单「编辑 → 撤销 / 重做」焦点不在文件树时的原生撤销 / 重做(webContents.undo / redo,同 role 菜单项)。
export const WINDOW_VIEW_ACTIONS = ['reload', 'toggleFullScreen', 'undo', 'redo'] as const;
export type WindowViewAction = (typeof WINDOW_VIEW_ACTIONS)[number];
/** window:view-action 的 popoutName 上限(dockview popout 名 = `<dockview id>-<组 id>`,远小于此)。 */
export const POPOUT_NAME_MAX = 256;
/** window:view-action 的可选目标:popout 子窗的 window.open 名。 */
export interface WindowViewActionTarget {
  readonly popoutName?: string;
}

/** 只出现在代码编辑器右键菜单里的菜单命令(edit-context-menu:更改所有匹配项 / 格式化文档;命令面板同时在应用菜单里)。 */
export const EDITOR_CONTEXT_MENU_COMMAND_IDS = [
  'editor.action.changeAll',
  'editor.action.formatDocument',
  'editor.action.revealDefinition',
] as const;

/**
 * 应用菜单项即 renderer 命令(对齐 VSCode 菜单栏 MenuId.MenubarXxx 的命令项):main 只认这些 id 发 RUN_MENU_COMMAND,renderer
 * 只执行这些 id。菜单上的 accelerator 由 renderer 推送的生效键位换算(SET_MENU_KEYBINDINGS),只作显示:按键由 renderer 的
 * 全局热键分发处理(VSCode 同:菜单键位来自渲染进程的 keybinding service)。BDD: src/__tests__/app-menu-bar/
 */
export const MENU_COMMAND_IDS = [
  // 文件
  'workbench.action.files.newUntitledFile',
  'workbench.action.files.openFolder',
  'workbench.action.openRecent',
  'workbench.action.files.save',
  'workbench.action.files.saveAs',
  'workbench.action.files.saveAll',
  'workbench.action.toggleAutoSave',
  'workbench.action.reopenClosedEditor',
  'workbench.action.files.revert',
  'workbench.action.closeActiveEditor',
  'workbench.action.closeFolder',
  // 首选项(macOS 应用菜单;其它平台 文件 → 首选项)
  'workbench.action.openSettings',
  'workbench.action.openGlobalKeybindings',
  // 编辑
  'actions.find',
  'editor.action.startFindReplaceAction',
  'workbench.action.findInFiles',
  'editor.action.commentLine',
  'editor.action.blockComment',
  // 选择
  'expandLineSelection',
  'editor.action.copyLinesUpAction',
  'editor.action.copyLinesDownAction',
  'editor.action.moveLinesUpAction',
  'editor.action.moveLinesDownAction',
  'editor.action.insertCursorAbove',
  'editor.action.insertCursorBelow',
  'editor.action.addSelectionToNextFindMatch',
  'editor.action.selectHighlights',
  // 编辑器右键菜单专用(不在应用菜单栏里;VSCode 同),见 EDITOR_CONTEXT_MENU_COMMAND_IDS
  ...EDITOR_CONTEXT_MENU_COMMAND_IDS,
  // 显示
  'workbench.action.showCommands',
  'workbench.view.explorer',
  'workbench.view.debug',
  'workbench.view.output',
  'workbench.action.terminal.toggleTerminal',
  'explorer.toggleSidebar',
  'editor.action.toggleWordWrap',
  'workbench.action.zoomReset',
  'workbench.action.zoomIn',
  'workbench.action.zoomOut',
  'workbench.action.splitEditor',
  'workbench.action.splitEditorDown',
  // 转到
  'workbench.action.navigateBack',
  'workbench.action.navigateForward',
  'workbench.action.quickOpen',
  'workbench.action.gotoSymbol',
  'workbench.action.gotoLine',
  'editor.action.jumpToBracket',
  'editor.action.marker.nextInFiles',
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.nextEditor',
  'workbench.action.previousEditor',
  // 终端
  'terminal.new',
  'workbench.action.terminal.split',
] as const;

export type MenuCommandId = (typeof MENU_COMMAND_IDS)[number];

/** 勾选类菜单项(type: 'checkbox';勾选状态由 renderer 经 SET_MENU_CHECKED 推送)。 */
export const MENU_CHECKBOX_IDS = ['workbench.action.toggleAutoSave'] as const satisfies readonly MenuCommandId[];
export type MenuCheckboxId = (typeof MENU_CHECKBOX_IDS)[number];

const MENU_CHECKBOX_ID_SET: ReadonlySet<string> = new Set(MENU_CHECKBOX_IDS);

export function isMenuCheckboxId(id: unknown): id is MenuCheckboxId {
  return typeof id === 'string' && MENU_CHECKBOX_ID_SET.has(id);
}

const MENU_COMMAND_ID_SET: ReadonlySet<string> = new Set(MENU_COMMAND_IDS);

export function isMenuCommandId(id: unknown): id is MenuCommandId {
  return typeof id === 'string' && MENU_COMMAND_ID_SET.has(id);
}

/**
 * RUN_MENU_COMMAND 的 payload:id = 菜单命令;fromPopout = 获焦的是 dockview popout 子窗(命令作用于该子窗,见 getCommandDocument);
 * viaKey = 由菜单 accelerator 触发(Electron triggeredByAccelerator)—— 按键已先经 renderer 分发而未被处理,renderer 按
 * 命令的上下文条件(when)重新判定,不成立不执行(VSCode 同:accelerator 触发时交给渲染进程按键位重新解析)。
 */
export interface MenuCommandPayload {
  readonly id: MenuCommandId;
  readonly fromPopout: boolean;
  readonly viaKey: boolean;
}

/** EDIT_UNDO_REDO 的 payload:op = 撤销 / 重做;fromPopout = 获焦的是 dockview popout 子窗。 */
export interface EditUndoRedoPayload {
  readonly op: 'undo' | 'redo';
  readonly fromPopout: boolean;
}

/** EDIT_UNDO_REDO payload 校验(renderer 侧;preload 不校验)。 */
export function isEditUndoRedoPayload(raw: unknown): raw is EditUndoRedoPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;
  return (p['op'] === 'undo' || p['op'] === 'redo') && typeof p['fromPopout'] === 'boolean';
}

/** RUN_MENU_COMMAND payload 校验(renderer 侧;preload 不校验)。 */
export function isMenuCommandPayload(raw: unknown): raw is MenuCommandPayload {
  if (typeof raw !== 'object' || raw === null) return false;
  const p = raw as Record<string, unknown>;
  return isMenuCommandId(p['id']) && typeof p['fromPopout'] === 'boolean' && typeof p['viaKey'] === 'boolean';
}

/** SET_MENU_KEYBINDINGS 每条键位的长度上限(与命令注册表 CMD_HOTKEY_MAX 同值,只挡滥用)。 */
export const MENU_HOTKEY_MAX = 64;

/** window:create 入参:由 main 的 zod schema 推出(单一来源,见 window-create-schema.ts)。 */
export type IpcWindowCreateInput = z.infer<typeof WindowCreateInputSchema>;

