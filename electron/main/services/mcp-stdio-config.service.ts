// stdio MCP 配置 holder(纯 module-level state)。
// main/index.ts 启动 stdio 后调 setStdioConfig 缓存当前配置;
// ipc handler 通过 getStdioConfig 读出来,转发给 renderer 用于"复制 MCP 配置"按钮。
//
// 解耦:避免 ipc.ts 反向 import main/index.ts 引发循环依赖。

import type { StdioMcpConfig } from '../../shared/mcp-channels';

let cached: StdioMcpConfig = { available: false };

export function setStdioConfig(config: StdioMcpConfig): void {
  cached = config;
}

export function getStdioConfig(): StdioMcpConfig {
  return cached;
}

/** 测试用:重置缓存. */
export function _resetForTest(): void {
  cached = { available: false };
}
