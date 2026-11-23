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
} as const;

/** window:create 入参:由 main 的 zod schema 推出(单一来源,见 window-create-schema.ts)。 */
export type IpcWindowCreateInput = z.infer<typeof WindowCreateInputSchema>;

