// MCP host 配置查询通道(P4+ stdio transport)。
// renderer 通过 invoke 拿当前的 stdio MCP config(完整 add 命令;没有即不可用),
// 给状态栏"复制 MCP 配置"按钮用。

export const MCP_CHANNELS = {
  /** renderer → main invoke:返回 stdio MCP 配置(命令字符串可直接 copy 跑). */
  GET_STDIO_CONFIG: 'mcp:get-stdio-config',
} as const;

export interface StdioMcpConfig {
  /**
   * 完整 `claude mcp add ...` 命令字符串,可直接 copy 跑。缺省 = 不可用(stdio server 未起来,
   * 或没有稳定的 CLI 路径可给)。
   */
  readonly claudeAddCommand?: string;
}
