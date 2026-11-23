// MCP host 配置查询通道(P4+ stdio transport)。
// renderer 通过 invoke 拿当前的 stdio MCP config(是否可用 + 完整 add 命令),
// 给状态栏"复制 MCP 配置"按钮用。

export const MCP_CHANNELS = {
  /** renderer → main invoke:返回 stdio MCP 配置(命令字符串可直接 copy 跑). */
  GET_STDIO_CONFIG: 'mcp:get-stdio-config',
} as const;

export interface StdioMcpConfig {
  /** stdio server 是否在运行(stdio server 起来后为 true;Windows 走命名管道). */
  readonly available: boolean;
  /** 完整 `claude mcp add ...` 命令字符串,可直接 copy 跑. */
  readonly claudeAddCommand?: string;
}
