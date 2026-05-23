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

/**
 * 构造 "复制 MCP 配置" 按钮内容(Claude Code 一次配置永久使用)。
 *
 * Format is part of Continuo's UX contract — users paste this verbatim into
 * Claude Code config and expect it to keep working across Continuo upgrades。
 * **MUST NOT change** without explicit user communication (UX-breaking)。
 *
 * Pure function in this file(not inlined in index.ts)so a byte-exact unit
 * test can pin the format without booting Electron。Replaces manual UX verify
 * (dev build → StatusBar 按钮 → clipboard diff)per ADR 0006 CT-B3 P1-1。
 */
export function buildClaudeAddCommand(cliPath: string): string {
  return `claude mcp add --transport stdio continuo -- ${cliPath}`;
}
