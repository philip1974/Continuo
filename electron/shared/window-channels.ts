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
} as const;

/** window:create 入参:由 main 的 zod schema 推出(单一来源,见 window-create-schema.ts)。 */
export type IpcWindowCreateInput = z.infer<typeof WindowCreateInputSchema>;

