// 终审 P1:终端退出吊销其专属 MCP token,却不回收该 token 经 HTTP MCP 创建的 debug 会话。
// 终端内的 agent 用终端 token 调 debug.launch → 会话的 controllerToken 即该 token(带 Mcp-Session-Id 时为
// token + session id);关终端后 token 失效,再无人能 disconnect 这些会话,重复数次即占满窗口名额、adapter 常驻。
// 修复:终端专属 token 的吊销器(mcpRevokers().byToken,仅终端退出 / 创建回滚调用)对该 token 下的每个调用方
// subject 同步 killByController(subject, 'terminal-exit'),与 stdio 断连路径一致。接线见 mcp-revoker-wiring。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpHost, type McpHost } from '../../../electron/main/services/mcp-host.service';
import { createMcpRevokerWiring } from '../../../electron/main/services/mcp-revoker-wiring';

let host: McpHost | null = null;
afterEach(async () => {
  if (host) await host.close();
  host = null;
  vi.restoreAllMocks();
});

async function initialize(token: string): Promise<string> {
  const r = await fetch(host!.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }),
  });
  await r.text();
  return r.headers.get('mcp-session-id')!;
}

describe('终端 token 吊销同步回收其 debug 会话', () => {
  it('byToken 吊销器对该 token 的每个调用方 subject killByController(subject, terminal-exit),失败 catch 记日志', async () => {
    const killByController = vi.fn(async (_subject: string, _reason: string): Promise<unknown> => []);
    const wiring = createMcpRevokerWiring({
      debugService: { killByController, listControllerTokens: () => [] },
      cancelAgentTerminalCreates: () => {},
      hasAgentTerminalCreates: () => false,
      hasLiveSessionForController: () => false,
    });
    host = await createMcpHost(wiring.hostOptions);
    const token = host.issueWindowToken(1);
    const sid = await initialize(token);
    killByController.mockRejectedValueOnce(new Error('teardown failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    wiring.revokers(host).byToken(token);

    expect(killByController.mock.calls.map((c) => c.join('|')).sort()).toEqual(
      [`${token}:${sid}|terminal-exit`, `${token}|terminal-exit`].sort(),
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});
