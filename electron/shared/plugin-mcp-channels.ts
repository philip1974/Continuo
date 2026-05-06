// Plugin → MCP Bridge — IPC channel 名 + error code 常量 + 纯类型。
//
// **不 import zod**,确保 preload sandbox bundle 能加载(preload import 此文件)。
// zod schema 见同目录 plugin-mcp-schemas.ts(只 main / renderer 用)。
//
// BDD: src/__tests__/plugin-mcp-ipc-bridge/

// ── channel 名常量 ─────────────────────────────────────────────

export const PLUGIN_MCP_CHANNELS = {
  /** renderer → main: 注册 tool 元数据. */
  REGISTER: 'plugin-mcp:register',
  /** renderer → main: 摘掉 tool. */
  UNREGISTER: 'plugin-mcp:unregister',
  /** main → renderer: 反向调用 tool.run. */
  INVOKE: 'plugin-mcp:invoke',
  /** renderer → main: invoke 答复. */
  INVOKE_REPLY: 'plugin-mcp:invoke-reply',
} as const;

// ── error codes ───────────────────────────────────────────────

export const PLUGIN_MCP_ERROR_CODES = {
  TOOL_NAME_TAKEN: 'TOOL_NAME_TAKEN',
  NO_SUCH_TOOL: 'NO_SUCH_TOOL',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TOOL_DISPOSED: 'TOOL_DISPOSED',
  INVOKE_TIMEOUT: 'INVOKE_TIMEOUT',
  PLUGIN_GONE: 'PLUGIN_GONE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const;

export type PluginMcpErrorCode =
  (typeof PLUGIN_MCP_ERROR_CODES)[keyof typeof PLUGIN_MCP_ERROR_CODES];

// ── 纯类型(对应 plugin-mcp-schemas.ts 的 z.infer 形态)──────────
// 手写而非 z.infer 导出,以避免 preload 触达 zod。两侧需保持同步,
// schemas.ts 顶部注释提醒"改 schema 同步本文件类型"。

export interface RegisterPayload {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
}

export interface UnregisterPayload {
  readonly name: string;
}

export interface InvokePayload {
  readonly requestId: string;
  readonly name: string;
  readonly input: unknown;
}

export type InvokeReply =
  | { readonly requestId: string; readonly ok: true; readonly result: unknown }
  | {
      readonly requestId: string;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };
