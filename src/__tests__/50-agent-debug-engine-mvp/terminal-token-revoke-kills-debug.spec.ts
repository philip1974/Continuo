// 终审 P1:终端退出吊销其专属 MCP token,却不回收该 token 经 HTTP MCP 创建的 debug 会话。
// 终端内的 agent 用终端 token 调 debug.launch → 会话的 controllerToken 即该 token;关终端后 token 失效,
// 再无人能 disconnect 这些会话,重复数次即占满窗口名额、adapter 常驻。修复:终端专属 token 的吊销器
// (mcpRevokers().byToken,仅终端退出 / 创建回滚调用)同步 killByController(token, 'terminal-exit'),
// 与 stdio 断连路径一致。主进程接线依赖整套启动,这里按仓库惯例做源码钉。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');

describe('终端 token 吊销同步回收其 debug 会话', () => {
  it('byToken 吊销器先 revokeToken,再 killByController(token, terminal-exit) 且 catch 记日志', () => {
    const start = src.indexOf('setMcpRevokers({');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('\n    });', start);
    const byToken = src.slice(src.indexOf('byToken:', start), end);
    expect(byToken).toMatch(/mcpHost!?\.revokeToken\(token\)/);
    expect(byToken).toMatch(/debugService\s*\.killByController\(token,\s*'terminal-exit'\)\s*\.catch\(/);
  });
});
