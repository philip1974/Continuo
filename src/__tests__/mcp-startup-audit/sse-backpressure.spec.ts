// HTTP MCP SSE 输出背压(终审 P1,stdio 输出背压同族):broadcast(插件注册/注销触发 tools/list_changed 等)
// 直接 res.write(),忽略返回 false、不限 writableLength。不读取的 SSE 客户端让通知在写缓冲中无界堆积,
// 主进程内存无界增长。未读输出超过上限 → 销毁该连接并移出订阅集合;正常客户端照常收到通知。
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpHost,
  MAX_SSE_UNREAD_OUTPUT_BYTES,
  type McpHost,
} from '../../../electron/main/services/mcp-host.service';

let host: McpHost | null = null;
const reqs: http.ClientRequest[] = [];
afterEach(async () => {
  for (const r of reqs.splice(0)) r.destroy();
  if (host) await host.close();
  host = null;
});

function openSse(h: McpHost, token: string): Promise<http.IncomingMessage> {
  const url = new URL(h.url);
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { Authorization: `Bearer ${token}` },
      },
      resolve,
    );
    req.on('error', reject);
    reqs.push(req);
  });
}

describe('HTTP MCP SSE 输出背压', () => {
  it('客户端不读、未读输出超过上限 → 断开该连接;正常客户端照常收到后续通知', async () => {
    host = await createMcpHost({ initialTools: [] });
    const token = host.issueWindowToken(1);
    const slow = await openSse(host, token);
    slow.pause(); // 只连不读
    const fast = await openSse(host, token);
    let fastData = '';
    fast.setEncoding('utf8');
    fast.on('data', (chunk: string) => {
      fastData += chunk;
    });
    let slowClosed = false;
    slow.socket.once('close', () => {
      slowClosed = true;
    });

    const pad = 'x'.repeat(1024 * 1024);
    const rounds = Math.ceil((MAX_SSE_UNREAD_OUTPUT_BYTES * 2) / pad.length);
    for (let i = 0; i < rounds; i++) {
      host.broadcast('notifications/test', { pad });
      await new Promise((r) => setTimeout(r, 2));
    }
    host.broadcast('notifications/after');

    // 正常客户端不受影响:读到最后一条通知。
    await vi.waitFor(() => expect(fastData).toContain('notifications/after'), {
      timeout: 10_000,
      interval: 20,
    });
    // 暂停的连接须恢复读取才会感知断开:被服务端销毁则读完积压即 close;无背压上限则连接一直开着。
    slow.resume();
    await vi.waitFor(() => expect(slowClosed).toBe(true), { timeout: 10_000, interval: 50 });
    expect(fast.socket.destroyed).toBe(false);
  }, 30_000);
});
