// Window IPC 通道(多窗口支持,issue #23 Phase 1)。
// renderer 调 coApi.window.create 在已有 main process 内开新主窗口,可选携带
// workspace 路径(注入 query string,renderer 启动时优先用)。

export const WINDOW_CHANNELS = {
  CREATE: 'window:create',
  /**
   * renderer 在 workspace.root 变化时调 → main 维护 windowId→root 映射,
   * 供 MCP agent terminal_create_session 的默认 cwd 解析使用。
   */
  NOTIFY_ROOT: 'window:notify-root',
} as const;

export interface IpcWindowCreateInput {
  /** 可选 workspace 绝对路径 — 新窗口启动时直接打开此目录,跳过 explorer.json. */
  readonly workspace?: string;
}

export interface IpcWindowCreateResult {
  readonly windowId: number;
}
