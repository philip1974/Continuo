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
import { createMcpRevokerWiring } from '../../../electron/main/services/mcp-revoker-wiring';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';
import {
  cancelAgentTerminalCreates,
  hasAgentTerminalCreates,
  trackAgentTerminalCreate,
} from '../../../electron/main/services/agent-terminal-inflight';

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

  it('revokeToken 后该 token 的 session 一并作废,并逐个以 token-revoked 通知释放;其它 token 的 session 不受影响', async () => {
    subjects.length = 0;
    const released: [string, string][] = [];
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject, cause) => released.push([subject, cause]),
    });
    const token = host.issueWindowToken(1);
    const other = host.issueWindowToken(1);
    const sid1 = await initialize(token);
    const sid2 = await initialize(token);
    const otherSid = await initialize(other);
    await (await post(token, CALL, sid1)).text();
    await (await post(token, CALL, sid2)).text();
    host.revokeToken(token);
    expect(released).toEqual([
      [subjects[0], 'token-revoked'],
      [subjects[1], 'token-revoked'],
    ]);
    host.revokeToken(token); // 幂等:已释放的 session 不再通知
    expect(released).toHaveLength(2);
    const ok = await post(other, CALL, otherSid);
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('revokeWindowTokens 只释放该窗口 token 的 session(window-revoked),其它窗口不受影响', async () => {
    const released: [string, string][] = [];
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject, cause) => released.push([subject, cause]),
    });
    const tokA = host.issueWindowToken(1);
    const tokB = host.issueWindowToken(2);
    const sidA = await initialize(tokA);
    const sidB = await initialize(tokB);
    host.revokeWindowTokens(1);
    expect(released).toEqual([[`${tokA}:${sidA}`, 'window-revoked']]);
    const ok = await post(tokB, CALL, sidB);
    expect(ok.status).toBe(200);
    await ok.text();
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
      onHttpSessionReleased: (subject, cause) => released.push(`${cause}|${subject}`),
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
    expect(released).toEqual([`closed|${subjects[0]}`]);
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

  it('达到上限时驱逐空闲超阈值的最旧 session(并以 closed 通知释放);活跃 session 不被挤掉', async () => {
    // 只伪造 Date(fetch / http server 仍走真实计时器)。
    vi.useFakeTimers({ toFake: ['Date'] });
    const released: string[] = [];
    const causes: string[] = [];
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject, cause) => {
        released.push(subject);
        causes.push(cause);
      },
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
    expect(causes).toEqual(['closed']);
    const stillOk = await post(token, CALL, oldest);
    expect(stillOk.status).toBe(200);
    await stillOk.text();
  });

  // 攻击场景:受害 agent 停在断点 >30 分钟(无在途请求);持被窃 token 的攻击方反复 initialize 凑满上限 →
  // 驱逐受害方最旧 session → 释放回调 killByController 杀掉其 debug 会话 / 其终端会话沦为无人可控的孤儿。
  // 修复:名下仍有活跃资源(debug 会话、在途 create/launch、存活终端)的 subject 不被驱逐。
  it('空闲驱逐跳过名下仍有活跃资源的 session,改驱逐下一个空闲且无资源的', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const released: string[] = [];
    subjects.length = 0;
    const busy = new Set<string>();
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject) => released.push(subject),
      hasLiveResources: (subject) => busy.has(subject),
    });
    const token = host.issueWindowToken(1);
    const victim = await initialize(token);
    await (await post(token, CALL, victim)).text();
    busy.add(subjects.at(-1)!);
    vi.advanceTimersByTime(1000);
    const second = await initialize(token);
    for (let i = 2; i < MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST; i++) await initialize(token);
    vi.advanceTimersByTime(HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST * 2);
    const r = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(r.status).toBe(200);
    await r.text();
    expect(released).toHaveLength(1);
    expect(released[0]!.endsWith(`:${second}`)).toBe(true);
    const still = await post(token, CALL, victim);
    expect(still.status).toBe(200);
    await still.text();
  });

  it('所有空闲候选名下都有活跃资源 → 仍 429,不驱逐、不通知释放', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const released: string[] = [];
    host = await createMcpHost({
      initialTools: [whoami],
      onHttpSessionReleased: (subject) => released.push(subject),
      hasLiveResources: () => true,
    });
    const token = host.issueWindowToken(1);
    const first = await initialize(token);
    for (let i = 1; i < MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST; i++) await initialize(token);
    vi.advanceTimersByTime(HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST * 2);
    const over = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(over.status).toBe(429);
    await over.text();
    expect(released).toEqual([]);
    const ok = await post(token, CALL, first);
    expect(ok.status).toBe(200);
    await ok.text();
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

describe('空闲驱逐的活跃资源只读查询', () => {
  afterEach(() => {
    terminalSessions._reset();
    cancelAgentTerminalCreates();
  });

  it('hasLiveSessionForController:只认该 subject 创建且未退出的终端', () => {
    expect(terminalSessions.hasLiveSessionForController('tok:a')).toBe(false);
    terminalSessions.add({
      id: 't1',
      title: 'x',
      cwd: '/w',
      originHint: 'agent',
      ownerWindowId: 1,
      controllerToken: 'tok:a',
    });
    expect(terminalSessions.hasLiveSessionForController('tok:a')).toBe(true);
    expect(terminalSessions.hasLiveSessionForController('tok:b')).toBe(false);
    terminalSessions.setExited('t1', 0);
    expect(terminalSessions.hasLiveSessionForController('tok:a')).toBe(false);
  });

  it('hasAgentTerminalCreates:在途创建登记期间为 true,done 后为 false', () => {
    const t = trackAgentTerminalCreate('tok:a');
    expect(hasAgentTerminalCreates('tok:a')).toBe(true);
    expect(hasAgentTerminalCreates('tok:b')).toBe(false);
    t.done();
    expect(hasAgentTerminalCreates('tok:a')).toBe(false);
  });
});

// 回收接线(electron/main/services/mcp-revoker-wiring):真实 host + 假依赖,逐条路径验证回收行为。
describe('MCP 回收接线:token 吊销 / 窗口关闭 / DELETE / 空闲驱逐', () => {
  function makeDeps(live: { debug?: string[]; creates?: string[]; terminals?: string[] } = {}) {
    const calls: string[] = [];
    const deps = {
      debugService: {
        killByController: vi.fn(async (subject: string, reason: string) => {
          calls.push(`kill|${reason}|${subject}`);
          return [];
        }),
        listControllerTokens: vi.fn(() => live.debug ?? []),
      },
      cancelAgentTerminalCreates: vi.fn((subject: string) => {
        calls.push(`cancel|${subject}`);
      }),
      hasAgentTerminalCreates: vi.fn((subject: string) => (live.creates ?? []).includes(subject)),
      hasLiveSessionForController: vi.fn((subject: string) =>
        (live.terminals ?? []).includes(subject),
      ),
    };
    return { calls, deps };
  }

  async function setup(live?: Parameters<typeof makeDeps>[0]) {
    const { calls, deps } = makeDeps(live);
    const wiring = createMcpRevokerWiring(deps);
    host = await createMcpHost({ initialTools: [whoami], ...wiring.hostOptions });
    return { calls, deps, revokers: wiring.revokers(host) };
  }

  it('终端 token 吊销(byToken):token 本身与它的每个 session subject 都取消在途创建 + killByController(terminal-exit);其它 token 不动', async () => {
    const { calls, revokers } = await setup();
    const token = host!.issueWindowToken(1);
    const other = host!.issueWindowToken(1);
    const sid1 = await initialize(token);
    const sid2 = await initialize(token);
    const otherSid = await initialize(other);
    revokers.byToken(token);
    const expected = [token, `${token}:${sid1}`, `${token}:${sid2}`].flatMap((s) => [
      `cancel|${s}`,
      `kill|terminal-exit|${s}`,
    ]);
    expect([...calls].sort()).toEqual([...expected].sort());
    expect(host!.verifyAndResolveCtx(`Bearer ${token}`)).toBeNull();
    const ok = await post(other, CALL, otherSid);
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('窗口关闭(byWindow):该窗口 token 与 session 作废,但不经此回收(由 killByOwner / 终端 kill 负责)', async () => {
    const { calls, revokers } = await setup();
    const tokA = host!.issueWindowToken(1);
    const tokB = host!.issueWindowToken(2);
    const sidA = await initialize(tokA);
    const sidB = await initialize(tokB);
    revokers.byWindow(1);
    expect(calls).toEqual([]);
    expect(host!.verifyAndResolveCtx(`Bearer ${tokA}`)).toBeNull();
    const gone = await post(tokA, CALL, sidA);
    expect(gone.status).toBe(401);
    await gone.text();
    const ok = await post(tokB, CALL, sidB);
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it('DELETE 结束 session:该 subject 取消在途创建 + killByController(session-closed)', async () => {
    const { calls } = await setup();
    const token = host!.issueWindowToken(1);
    const sid = await initialize(token);
    const del = await post(token, {}, sid, 'DELETE');
    expect(del.status).toBe(200);
    await del.text();
    expect(calls).toEqual([`cancel|${token}:${sid}`, `kill|session-closed|${token}:${sid}`]);
  });

  it('空闲驱逐:被驱逐的 subject 同 DELETE 回收(session-closed);有 debug / 在途创建 / 存活终端的 session 不被驱逐', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const live: { debug: string[]; creates: string[]; terminals: string[] } = {
      debug: [],
      creates: [],
      terminals: [],
    };
    const { calls } = await setup(live);
    const token = host!.issueWindowToken(1);
    const sids: string[] = [];
    for (let i = 0; i < MAX_HTTP_SESSIONS_PER_TOKEN_FOR_TEST; i++) {
      sids.push(await initialize(token));
      vi.advanceTimersByTime(10);
    }
    // 最旧的三个各占一种活跃资源 → 跳过,驱逐第四个。
    live.debug.push(`${token}:${sids[0]}`);
    live.creates.push(`${token}:${sids[1]}`);
    live.terminals.push(`${token}:${sids[2]}`);
    vi.advanceTimersByTime(HTTP_SESSION_IDLE_EVICT_MS_FOR_TEST * 2);
    const r = await post(token, { id: 'init', method: 'initialize', params: {} });
    expect(r.status).toBe(200);
    await r.text();
    const victim = `${token}:${sids[3]}`;
    expect(calls).toEqual([`cancel|${victim}`, `kill|session-closed|${victim}`]);
  });

  it('killByController reject → 记 warn,不产生未处理 rejection', async () => {
    const { deps } = makeDeps();
    deps.debugService.killByController.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wiring = createMcpRevokerWiring(deps);
    wiring.revokers({ revokeToken: () => {}, revokeWindowTokens: () => {} }).byToken('tok');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('index.ts 用 createMcpRevokerWiring 接线(host 回调与吊销器)', () => {
    const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
    expect(src).toMatch(/createMcpHost\(\{ initialTools, \.\.\.revokerWiring\.hostOptions \}\)/);
    expect(src).toMatch(/setMcpRevokers\(revokerWiring\.revokers\(mcpHost\)\)/);
  });
});
