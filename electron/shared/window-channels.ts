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
   * 重启应用(插件安装后「立即重启」)。main 走与 ⌘Q 相同的退出流程(各窗口脏文件确认 / flush / 清理),全部通过后
   * app.relaunch() 再退出;用户取消 → 不退出也不重启。
   */
  RELAUNCH_APP: 'window:relaunch-app',
  /**
   * main → renderer:应用菜单里「即某条命令」的菜单项被点(或按其 accelerator)→ 请求目标主窗执行该命令(payload 命令 id,
   * 仅限 MENU_COMMANDS 登记的 id)。popout 子窗聚焦时发给打开它的主窗。
   */
  RUN_MENU_COMMAND: 'window:run-menu-command',
  /**
   * 命令面板里的「重新加载窗口 / 放大 / 缩小 / 重置缩放 / 切换全屏」(应用菜单 View 同款动作,payload `{ action }`,
   * 仅限 WINDOW_VIEW_ACTIONS):main 作用于发起方所在窗口;reload 走与菜单 ⌘R 相同的脏确认 + flush。
   */
  VIEW_ACTION: 'window:view-action',
} as const;

/** window:view-action 可执行的动作(BDD: src/__tests__/command-discoverability/)。 */
export const WINDOW_VIEW_ACTIONS = ['reload', 'zoomIn', 'zoomOut', 'resetZoom', 'toggleFullScreen'] as const;
export type WindowViewAction = (typeof WINDOW_VIEW_ACTIONS)[number];

/**
 * 应用菜单项即 renderer 命令:命令 id → 菜单 accelerator(必须等于该命令默认键,BDD explorer-commands 守护)。
 * 同一按键只执行一次:renderer 全局热键先收到 keydown 并 preventDefault,Electron 不再触发菜单 accelerator;renderer
 * 没处理时(改了键、焦点不在页面)才由菜单经 RUN_MENU_COMMAND 执行。对齐 VSCode 文件菜单「打开文件夹… ⌘O」、
 * 应用菜单「设置… ⌘,」。
 */
export const MENU_COMMANDS = {
  'workbench.action.files.openFolder': 'CmdOrCtrl+O',
  'settings.toggle': 'CmdOrCtrl+,',
} as const satisfies Record<string, string>;

export type MenuCommandId = keyof typeof MENU_COMMANDS;

export function isMenuCommandId(id: unknown): id is MenuCommandId {
  return typeof id === 'string' && Object.hasOwn(MENU_COMMANDS, id);
}

/** window:create 入参:由 main 的 zod schema 推出(单一来源,见 window-create-schema.ts)。 */
export type IpcWindowCreateInput = z.infer<typeof WindowCreateInputSchema>;

