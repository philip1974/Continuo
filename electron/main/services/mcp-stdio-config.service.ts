// stdio MCP 配置 holder(纯 module-level state)。
// main/index.ts 启动 stdio 后调 setStdioConfig 缓存当前配置;
// ipc handler 通过 getStdioConfig 读出来,转发给 renderer 用于"复制 MCP 配置"按钮。
//
// 解耦:避免 ipc.ts 反向 import main/index.ts 引发循环依赖。

import type { StdioMcpConfig } from '../../shared/mcp-channels';
import { posixSingleQuote } from '../lib/posix-shell-quote';

let cached: StdioMcpConfig = {};

export function setStdioConfig(config: StdioMcpConfig): void {
  cached = config;
}

export function getStdioConfig(): StdioMcpConfig {
  return cached;
}

/** 测试用:重置缓存. */
export function _resetForTest(): void {
  cached = {};
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
export function buildClaudeAddCommand(
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    // Windows 无 shebang 机制,不能把 `.mjs` 当可执行直接 spawn,且路径常含空格
    // (e.g. Program Files)→ 用 `node "<path>"` 显式调用并引用(跨平台审计 P1)。
    // 非 win 保持原 byte-exact 格式(UX 契约,见上)。
    // 残余风险(未处理,Windows 没有同时适用于 cmd 与 PowerShell 的转义):双引号内 cmd 仍展开 `%VAR%`,
    // PowerShell 仍展开 `$var` / `$(…)` / 反引号。Windows 路径不允许 `"`;`&` `^` 在双引号内按字面。
    return `claude mcp add --transport stdio continuo -- node "${cliPath}"`;
  }
  // 安全:该命令由用户粘贴进 shell(也会被写进剪贴板)。路径含空白会被拆成多个参数,含 `;` / `$(…)` /
  // 反引号则粘贴即执行 → 含安全字符集以外字符时做 POSIX 单引号转义。常规路径不加引号,输出逐字节不变(UX 契约)。
  const arg = SHELL_SAFE_PATH.test(cliPath) ? cliPath : posixSingleQuote(cliPath);
  return `claude mcp add --transport stdio continuo -- ${arg}`;
}

/** 无需引号即恰为一个 shell 词的路径字符集(sh / bash / zsh / fish 下均无特殊含义)。 */
const SHELL_SAFE_PATH = /^[A-Za-z0-9_./-]+$/;
