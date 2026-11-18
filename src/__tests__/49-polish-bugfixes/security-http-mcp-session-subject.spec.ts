// BDD: HTTP MCP 的 per-session capability 调用方身份绑定 Mcp-Session-Id,不再等于 env 中的 bearer token
//
// 攻击场景(威胁模型:已被提示注入、已获终端授权的 agent):HTTP 传输下 callerSubject 就是 bearer token,而 token
// 经 PTY env `CONTINUO_MCP_TOKEN` 注入每个终端。同用户进程可读其它进程的环境(macOS `ps eww -ax`、Linux
// /proc/<pid>/environ)。攻击方 agent 读到受害终端 agent 进程的 token → 带它直接 POST /mcp 调 read_output /
// send_input / kill / await_stop_hook 操作受害方经 HTTP 创建的会话,绕过 S3(会话只许创建方操作)。
//
// 修复:实现 MCP Streamable HTTP 的 `Mcp-Session-Id`(规范 2025-03-26 起:服务端在 initialize 响应下发,客户端
// MUST 在后续请求回带)。session id 由服务端随机生成、只存在于客户端内存(不进 env、不进日志),
// callerSubject = token + session id。攻击方拿到 token 也只能 initialize 出**自己的**新 session,身份与受害方不同;
// 伪造 / 跨 token 的 session id → 404(规范:未知 session 回 404)。未带 Mcp-Session-Id 的旧客户端保持
// callerSubject = token(行为不变),但与带 session 的客户端身份互不相通。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMcpHost,
  HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST,
  MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST,
  type AnyMcpTool,
  type McpCallCtx,
  type McpHost,
} from '../../../electron/main/services/mcp-host.service';

let host: McpHost | null = null;
afterEach(async () => {
  vi.useRealTimers();
  if (host) await host.close();
  host = null;
});

const subjects: (string | null | undefined)[] = [];
const whoami: AnyMcpTool = {
  name: 'whoami',
  description: 'records caller subject',
  jsonSchema: { type: 'object', additionalProperties: false },
  inputSchema: z.object({}).strict(),
  run: (_i: unknown, ctx: McpCallCtx) => {
    subjects.push(ctx.callerSubject);
    return { ok: true };
  },
};

async function post(
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
  method = 'POST',
): Promise<Response> {
  return fetch(host!.url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(sessionId !== undefined ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', ...body }) } : {}),
  });
}

async function initialize(token: string): Promise<string> {
  const r = await post(token, { id: 'init', method: 'initialize', params: {} });
  expect(r.status).toBe(200);
  const sid = r.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  await r.text();
  return sid!;
}

const CALL = { id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } };

describe('F1 · HTTP MCP callerSubject 绑定 Mcp-Session-Id', () => {
  it('initialize 响应下发随机 Mcp-Session-Id:不等于 token,也不出现在响应体', async () => {
    host = await createMcpHost({ initialTools: [whoami] });
    const token = host.issueWindowToken(1);
    const r = await post(token, { id: 'init', method: 'initialize', params: {} });
    const sid = r.headers.get('mcp-session-id');
    const text = await r.text();
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(sid).not.toBe(token);
    expect(text).not.toContain(sid!);
    expect(await initialize(token)).not.toBe(sid); // 每次 initialize 新 session
  });

  it('同一 token:受害方 session、攻击方自己 initialize 的 session、不带 session 三者 callerSubject 互不相同', async () => {
    subjects.length = 0;
    host = await createMcpHost({ initialTools: [whoami] });
    const token = host.issueWindowToken(1);
    const victimSid = await initialize(token);
    expect((await post(token, CALL, victimSid)).status).toBe(200);
    const attackerSid = await initialize(token); // 攻击方拿到 env 中的 token,只能开自己的 session
    expect((await post(token, CALL, attackerSid)).status).toBe(200);
    expect((await post(token, CALL)).status).toBe(200); // 不带 session(旧客户端)
    expect((await post(token, CALL, victimSid)).status).toBe(200); // 受害方后续调用身份稳定
    expect(subjects).toHaveLength(4);
    const [victim, attacker, legacy, victimAgain] = subjects;
    expect(victimAgain).toBe(victim);
    expect(new Set([victim, attacker, legacy]).size).toBe(3);
    expect(legacy).toBe(token); // 未带 session:行为不变
    for (const s of [victim, attacker]) expect(s).not.toBe(token);
  });

  it('伪造 / 属于别的 token 的 Mcp-Session-Id → 404,工具不执行', async () => {
    subjects.length = 0;
    host = await createMcpHost({ initialTools: [whoami] });
    const tokenA = host.issueWindowToken(1);
    const tokenB = host.issueWindowToken(1);
    const sidA = await initialize(tokenA);
    const forged = await post(tokenA, CALL, 'not-a-session');
    expect(forged.status).toBe(404);
    await forged.text();
    const crossToken = await post(tokenB, CALL, sidA);
    expect(crossToken.status).toBe(404);
    await crossToken.text();
    expect(subjects).toEqual([]);
  });

  it('revokeToken 后该 token 的 session 一并作废;callerSubjectsForToken 列出该 token 的全部身份(供撤销回收)', async () => {
    subjects.length = 0;
    host = await createMcpHost({ initialTools: [whoami] });
    const token = host.issueWindowToken(1);
    const sid = await initialize(token);
    await (await post(token, CALL, sid)).text();
    const listed = host.callerSubjectsForToken(token);
    expect(listed).toContain(token);
    expect(listed).toContain(subjects[0]);
    host.revokeToken(token);
    expect(host.callerSubjectsForToken(token)).toEqual([token]);
  });

  it('终端 token 吊销接线:先取 callerSubjectsForToken 再 revokeToken,逐个身份回收在途创建 / debug 会话', () => {
    const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    const fn = /byToken: \(token\) => \{[\s\S]*?\n {6}\},/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(
      /const subjects = mcpHost!\.callerSubjectsForToken\(token\);\s*mcpHost!\.revokeToken\(token\);/,
    );
    expect(fn).toMatch(/for \(const subject of subjects\)[\s\S]*cancelAgentTerminalCreates\(subject\)/);
    expect(fn).toMatch(/debugService\.killByController\(subject, 'terminal-exit'\)/);
  });

  it('DELETE 带 Mcp-Session-Id → 结束该 session,之后再用 → 404', async () => {
    host = await createMcpHost({ initialTools: [whoami] });
    const token = host.issueWindowToken(1);
    const sid = await initialize(token);
    const del = await post(token, {}, sid, 'DELETE');
    expect(del.status).toBe(200);
    await del.text();
    const after = await post(token, CALL, sid);
    expect(after.status).toBe(404);
    await after.text();
  });

  it('DELETE 结束 session → 以该 session 的 callerSubject 通知释放(供回收其 debug 会话 / 在途创建);伪造 sid 不通知', async () => {
    subjects.length = 0;
    const released: string[] = [];
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject) => released.push(subject),
    });
    const token = host.issueWindowToken(1);
    const sid = await initialize(token);
    await (await post(token, CALL, sid)).text();
    const forged = await post(token, {}, 'not-a-session', 'DELETE');
    expect(forged.status).toBe(404);
    await forged.text();
    expect(released).toEqual([]);
    const del = await post(token, {}, sid, 'DELETE');
    expect(del.status).toBe(200);
    await del.text();
    expect(released).toEqual([subjects[0]]);
  });

  it('session 释放接线:index.ts 对释放的 subject 同 token 吊销一样取消在途创建 + killByController', () => {
    const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    const fn = /onHttpSessionReleased: \(subject\) => \{[\s\S]*?\n {6}\},/.exec(src)?.[0] ?? '';
    expect(fn).toMatch(/cancelAgentTerminalCreates\(subject\)/);
    expect(fn).toMatch(/debugService\.killByController\(subject, 'session-closed'\)\s*\.catch\(/);
  });

  it('单 token 的 session 数有上限:超限 initialize → 429,已有 session 不受影响', async () => {
    host = await createMcpHost({ initialTools: [whoami] });
    const token = host.issueWindowToken(1);
    const first = await initialize(token);
    for (let i = 1; i < MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST; i++) await initialize(token);
    const over = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(over.status).toBe(429);
    expect(over.headers.get('mcp-session-id')).toBeNull();
    await over.text();
    const ok = await post(token, CALL, first);
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('达到上限时驱逐空闲超阈值的最旧 session(并通知释放);活跃 session 不被挤掉', async () => {
    // 只伪造 Date(fetch / http server 仍走真实计时器)。
    vi.useFakeTimers({ toFake: ['Date'] });
    const released: string[] = [];
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject) => released.push(subject),
    });
    const token = host.issueWindowToken(1);
    const oldest = await initialize(token);
    vi.advanceTimersByTime(1000);
    const second = await initialize(token);
    for (let i = 2; i < MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST; i++) await initialize(token);
    // 未到空闲阈值:仍 429(不驱逐活跃 session,避免持 token 的攻击方挤掉受害方)。
    vi.advanceTimersByTime(HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST - 2000);
    const busy = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(busy.status).toBe(429);
    await busy.text();
    // 最旧的那个刚被使用过 → 变活跃;越过阈值后被驱逐的是第二旧的空闲 session。
    await (await post(token, CALL, oldest)).text();
    vi.advanceTimersByTime(HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST);
    await (await post(token, CALL, oldest)).text();
    const r = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toBeTruthy();
    await r.text();
    const evicted = await post(token, CALL, second);
    expect(evicted.status).toBe(404);
    await evicted.text();
    expect(released).toHaveLength(1);
    expect(released[0]!.endsWith(`:${second}`)).toBe(true);
    const stillOk = await post(token, CALL, oldest);
    expect(stillOk.status).toBe(200);
    await stillOk.text();
  });

  it('在途请求中的 session(如长时间 await)即使超过空闲阈值也不被驱逐', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let unblock: () => void = () => {};
    const blocker: AnyMcpTool = {
      name: 'block',
      description: 'blocks until released',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => new Promise((resolve) => (unblock = () => resolve({ ok: true }))),
    };
    host = await createMcpHost({ initialTools: [whoami, blocker] });
    const token = host.issueWindowToken(1);
    const busySid = await initialize(token);
    for (let i = 1; i < MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST; i++) await initialize(token);
    const pending = post(token, { id: 2, method: 'tools/call', params: { name: 'block', arguments: {} } }, busySid);
    await new Promise((r) => setTimeout(r, 50)); // 让请求进入 dispatch
    vi.advanceTimersByTime(HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST * 2);
    const r = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(r.status).toBe(200); // 驱逐的是别的空闲 session
    await r.text();
    unblock();
    expect((await pending).status).toBe(200);
    const still = await post(token, CALL, busySid);
    expect(still.status).toBe(200);
    await still.text();
  });
});
