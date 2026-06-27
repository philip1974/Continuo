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
  // 边界(E79):单 webContents / 全局注册 tool 数量超上限(防恶意插件循环注册海量 tool 撑爆
  // main entries/host.tools + tools/list 广播放大)。
  TOO_MANY_TOOLS: 'TOO_MANY_TOOLS',
  // 边界(E228,E227/E79 in-flight 数量上限族):反向 invoke 在途(pending)数量超上限(防外部 MCP
  // client 并发 spam 海量 tools/call,累计 pending + 30s timer + IPC 放大 main 内存/事件循环压力)。
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  NO_SUCH_TOOL: 'NO_SUCH_TOOL',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TOOL_DISPOSED: 'TOOL_DISPOSED',
  INVOKE_TIMEOUT: 'INVOKE_TIMEOUT',
  PLUGIN_GONE: 'PLUGIN_GONE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  // 插件 host 回的 reply 畸形(ok 既非 true 也非 false):若不显式 reject,
  // 因 handleReply 已先 cancel timer + 删 pending,该 invoke 会永久挂起。
  INVALID_REPLY: 'INVALID_REPLY',
  // 边界(E262):plugin tool run() 结果非 JSON 安全 / 序列化超 RESULT_BYTES_MAX。renderer bridge 发 IPC
  // 前预检(避免「校验太晚」—— 结果先跨 preload→main structured-clone 才在 main 校验放大内存),超限不
  // 发原 result,改回此稳定 ok:false 错误,使对应 pending invoke 立即收口。
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
} as const;

export type PluginMcpErrorCode =
  (typeof PLUGIN_MCP_ERROR_CODES)[keyof typeof PLUGIN_MCP_ERROR_CODES];

// ── 纯类型(对应 plugin-mcp-schemas.ts 的 z.infer 形态)──────────
// 手写而非 z.infer 导出,以避免 preload 触达 zod。

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
