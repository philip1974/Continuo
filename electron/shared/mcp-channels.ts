// MCP host 配置查询通道(P4+ stdio transport)。
// renderer 通过 invoke 拿当前的 stdio MCP config(CLI 路径 / socket / 完整 add 命令),
// 给状态栏"复制 MCP 配置"按钮用。

export const MCP_CHANNELS = {
  /** renderer → main invoke:返回 stdio MCP 配置(命令字符串可直接 copy 跑). */
  GET_STDIO_CONFIG: 'mcp:get-stdio-config',
} as const;

export type McpChannel = (typeof MCP_CHANNELS)[keyof typeof MCP_CHANNELS];

export interface StdioMcpConfig {
  /** stdio server 是否在运行(macOS/Linux true,Win 当前 false). */
  readonly available: boolean;
  /** CLI proxy 绝对路径(packaged 走 Resources,dev 走 scripts/). */
  readonly cliPath?: string;
  /** Unix socket 路径(debug 用). */
  readonly socketPath?: string;
  /** 完整 `claude mcp add ...` 命令字符串,可直接 copy 跑. */
  readonly claudeAddCommand?: string;
}
