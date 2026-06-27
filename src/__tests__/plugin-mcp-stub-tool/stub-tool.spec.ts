// BDD: plugin-mcp-stub-tool
// 测 main 侧 PluginMcpBridge 的纯函数层:createStubTool + createInvokeRemote。
//
// 此 spec 在实装前会 red(module 不存在)。实装目标:
//   electron/main/services/plugin-mcp-bridge.service.ts 按下面 import 的形态 export。

import { describe, it, expect, vi } from 'vitest';
import {
  createStubTool,
  createInvokeRemote,
  MAX_INFLIGHT_INVOKES_GLOBAL_FOR_TEST,
  MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST,
  type CreateInvokeRemoteDeps,
  type PluginMcpToolOwner,
  type PluginMcpRegistrationSpec,
} from '../../../electron/main/services/plugin-mcp-bridge.service';
import { PLUGIN_MCP_CHANNELS, PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';

// ─── 时钟 / requestId 注入 ───────────────────────────────────

interface FakeTimer {
  id: number;
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

function makeFakeTimerSetup() {
  const timers: FakeTimer[] = [];
  let nextId = 1;
  const setTimer: NonNullable<CreateInvokeRemoteDeps['setTimer']> = (fn, ms) => {
    const t: FakeTimer = { id: nextId++, fn, ms, cancelled: false };
    timers.push(t);
    return {
      cancel() {
        t.cancelled = true;
      },
    };
  };
  const fireOldest = (): void => {
    const t = timers.find((x) => !x.cancelled);
    if (!t) throw new Error('no live timer to fire');
    t.cancelled = true;
    t.fn();
  };
  return { timers, setTimer, fireOldest };
}

function makeIdGen(prefix = 'r'): NonNullable<CreateInvokeRemoteDeps['newRequestId']> {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

// ─── fixtures ────────────────────────────────────────────────

const owner1: PluginMcpToolOwner = { pluginId: 'p.alpha', wcId: 11 };
const owner2: PluginMcpToolOwner = { pluginId: 'p.beta', wcId: 22 };

const echoSpec: PluginMcpRegistrationSpec = {
  name: 'echo',
  description: 'echo back',
  jsonSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

// ────────────────────────────────────────────────────────────
// createStubTool — 形态
// ────────────────────────────────────────────────────────────

describe('createStubTool', () => {
  it('返回的 McpToolDef 字段透传 spec', () => {
    const stub = createStubTool(echoSpec, owner1, async () => ({}));
    expect(stub.name).toBe('echo');
    expect(stub.description).toBe('echo back');
    expect(stub.jsonSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  it('inputSchema 是 z.unknown 形态(允许任意输入,main 不预校)', () => {
    const stub = createStubTool(echoSpec, owner1, async () => ({}));
    // safeParse 任意值都通过(主流证据是 z.unknown / z.any 行为)
    expect(stub.inputSchema.safeParse(undefined).success).toBe(true);
    expect(stub.inputSchema.safeParse({ a: 1 }).success).toBe(true);
    expect(stub.inputSchema.safeParse('hi').success).toBe(true);
    expect(stub.inputSchema.safeParse(42).success).toBe(true);
  });

  it('run(input) 调 invoke(owner, spec.name, input) 一次,原样转发', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const stub = createStubTool(echoSpec, owner1, invoke);
    const r = await stub.run({ text: 'hi' }, { ownerWindowId: 1 });
    expect(r).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(owner1, 'echo', { text: 'hi' });
  });

  it('run reject 透传 invoke 的错(原对象,含 code)', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), {
        code: PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT,
      });
    });
    const stub = createStubTool(echoSpec, owner1, invoke);
    const err = await stub.run({}, { ownerWindowId: 1 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('timeout');
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT,
    );
  });
});

// ────────────────────────────────────────────────────────────
// createInvokeRemote · invoke 发送
// ────────────────────────────────────────────────────────────

describe('createInvokeRemote · invoke 发送', () => {
  it('调 send 一次,channel=INVOKE,payload 含 requestId/name/input', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({
      send,
      setTimer,
      newRequestId: makeIdGen(),
    });
    void core.invoke(owner1, 'echo', { text: 'hi' });
    expect(send).toHaveBeenCalledOnce();
    const [calledOwner, channel, payload] = send.mock.calls[0]!;
    expect(calledOwner).toEqual(owner1);
    expect(channel).toBe(PLUGIN_MCP_CHANNELS.INVOKE);
    expect(payload).toEqual({ requestId: 'r-1', name: 'echo', input: { text: 'hi' } });
  });

  it('input 任意类型透传(undefined / null / primitive / array)', () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    void core.invoke(owner1, 'x', undefined);
    void core.invoke(owner1, 'x', null);
    void core.invoke(owner1, 'x', 42);
    void core.invoke(owner1, 'x', [1, 2]);
    expect(send.mock.calls.map((c) => c[2])).toEqual([
      { requestId: 'r-1', name: 'x', input: undefined },
      { requestId: 'r-2', name: 'x', input: null },
      { requestId: 'r-3', name: 'x', input: 42 },
      { requestId: 'r-4', name: 'x', input: [1, 2] },
    ]);
  });

  it('每次 invoke 拿到新 requestId,pending 计数递增', () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    void core.invoke(owner1, 'a', {});
    void core.invoke(owner1, 'b', {});
    void core.invoke(owner2, 'c', {});
    expect(core.pendingCount()).toBe(3);
  });
});

// ────────────────────────────────────────────────────────────
// createInvokeRemote · handleReply 路由
// ────────────────────────────────────────────────────────────

describe('createInvokeRemote · handleReply', () => {
  it('ok=true reply → 对应 invoke resolve(result),pending 减一', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const p = core.invoke(owner1, 'echo', { text: 'hi' });
    expect(core.pendingCount()).toBe(1);
    core.handleReply({ requestId: 'r-1', ok: true, result: { echoed: 'hi' } });
    await expect(p).resolves.toEqual({ echoed: 'hi' });
    expect(core.pendingCount()).toBe(0);
  });

  it('ok=false reply → 对应 invoke reject Error(code/message)', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const p = core.invoke(owner1, 'x', {});
    core.handleReply({
      requestId: 'r-1',
      ok: false,
      code: PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL,
      message: 'tool x not found',
    });
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).message).toBe('tool x not found');
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL,
    );
  });

  it('未知 requestId(已超时 / 已处理)→ 静默忽略,不抛', () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    expect(() =>
      core.handleReply({ requestId: 'no-such', ok: true, result: 1 }),
    ).not.toThrow();
  });

  it('reply 后再 reply 同 id → 第二次静默忽略', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const p = core.invoke(owner1, 'x', {});
    core.handleReply({ requestId: 'r-1', ok: true, result: 'a' });
    await expect(p).resolves.toBe('a');
    expect(() =>
      core.handleReply({ requestId: 'r-1', ok: true, result: 'b' }),
    ).not.toThrow();
    expect(core.pendingCount()).toBe(0);
  });

  it('多个并发 invoke 各自路由(reply 顺序乱序也能对上)', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const p1 = core.invoke(owner1, 'a', {});
    const p2 = core.invoke(owner1, 'b', {});
    const p3 = core.invoke(owner2, 'c', {});
    // 乱序 reply
    core.handleReply({ requestId: 'r-3', ok: true, result: 'C' });
    core.handleReply({ requestId: 'r-1', ok: true, result: 'A' });
    core.handleReply({ requestId: 'r-2', ok: true, result: 'B' });
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['A', 'B', 'C']);
  });
});

// ────────────────────────────────────────────────────────────
// createInvokeRemote · 超时
// ────────────────────────────────────────────────────────────

describe('createInvokeRemote · 超时', () => {
  it('默认 timeoutMs=30000,超时 reject INVOKE_TIMEOUT', async () => {
    const send = vi.fn();
    const setup = makeFakeTimerSetup();
    const core = createInvokeRemote({
      send,
      setTimer: setup.setTimer,
      newRequestId: makeIdGen(),
    });
    const p = core.invoke(owner1, 'x', {});
    expect(setup.timers[0]?.ms).toBe(30000);
    setup.fireOldest();
    const err = await p.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT,
    );
  });

  it('自定义 timeoutMs 透传给 setTimer', () => {
    const send = vi.fn();
    const setup = makeFakeTimerSetup();
    const core = createInvokeRemote({
      send,
      setTimer: setup.setTimer,
      newRequestId: makeIdGen(),
      timeoutMs: 5000,
    });
    void core.invoke(owner1, 'x', {});
    expect(setup.timers[0]?.ms).toBe(5000);
  });

  it('超时后再来 reply 同 id → 静默忽略,不 double-resolve', async () => {
    const send = vi.fn();
    const setup = makeFakeTimerSetup();
    const core = createInvokeRemote({
      send,
      setTimer: setup.setTimer,
      newRequestId: makeIdGen(),
    });
    const p = core.invoke(owner1, 'x', {});
    setup.fireOldest();
    await p.catch(() => {});
    expect(() =>
      core.handleReply({ requestId: 'r-1', ok: true, result: 'late' }),
    ).not.toThrow();
  });

  it('reply 先到 → 取消 timer(避免后续 fire)', async () => {
    const send = vi.fn();
    const setup = makeFakeTimerSetup();
    const core = createInvokeRemote({
      send,
      setTimer: setup.setTimer,
      newRequestId: makeIdGen(),
    });
    const p = core.invoke(owner1, 'x', {});
    core.handleReply({ requestId: 'r-1', ok: true, result: 'ok' });
    await p;
    expect(setup.timers[0]?.cancelled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// abortByWebContents
// ────────────────────────────────────────────────────────────

describe('abortByWebContents', () => {
  it('reject 所有 owner.wcId === 输入 wcId 的 pending,code=PLUGIN_GONE', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const p1 = core.invoke(owner1, 'a', {}); // wcId=11
    const p2 = core.invoke(owner1, 'b', {}); // wcId=11
    const p3 = core.invoke(owner2, 'c', {}); // wcId=22
    core.abortByWebContents(11);
    const e1 = await p1.catch((e: unknown) => e);
    const e2 = await p2.catch((e: unknown) => e);
    expect((e1 as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE,
    );
    expect((e2 as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE,
    );
    // p3 仍 pending(不同 wc 不动)
    expect(core.pendingCount()).toBe(1);
    // 清理
    core.handleReply({ requestId: 'r-3', ok: true, result: 0 });
    await p3;
  });

  it('abort 后 pending 中该 wc 的 entry 全摘掉', () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    core.invoke(owner1, 'a', {}).catch(() => {});
    core.invoke(owner1, 'b', {}).catch(() => {});
    core.abortByWebContents(11);
    expect(core.pendingCount()).toBe(0);
  });

  it('abort 已被取消(已 reply 的)→ 幂等不抛', () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    void core.invoke(owner1, 'a', {});
    core.handleReply({ requestId: 'r-1', ok: true, result: 1 });
    expect(() => core.abortByWebContents(11)).not.toThrow();
  });

  it('abort 不存在的 wcId → noop', () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    void core.invoke(owner1, 'a', {});
    core.abortByWebContents(999);
    expect(core.pendingCount()).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// 边界(E228):在途(pending)数量上限 —— 全局 + per-webContents 双闸
// ────────────────────────────────────────────────────────────

describe('createInvokeRemote · 在途数量上限(E228)', () => {
  it('单 wc 在途到 per-wc 上限后,再 invoke 立即 reject TOO_MANY_REQUESTS,不入 pending、不再发 IPC', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const max = MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST;
    // 凑满 per-wc 在途
    for (let i = 0; i < max; i++) void core.invoke(owner1, 'x', {});
    expect(core.pendingCount()).toBe(max);
    expect(send).toHaveBeenCalledTimes(max);
    // 第 max+1 次:立即 reject,不入 pending、不发 IPC
    const overflow = core.invoke(owner1, 'x', {});
    const err = await overflow.catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS,
    );
    expect(core.pendingCount()).toBe(max); // 没增
    expect(send).toHaveBeenCalledTimes(max); // 没多发
  });

  it('终态(reply)释放在途槽位后,可再接受新 invoke(计数对偶,无漂移)', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen('r') });
    const max = MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST;
    for (let i = 0; i < max; i++) void core.invoke(owner1, 'x', {});
    // 满了 → 溢出
    let err = await core.invoke(owner1, 'x', {}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS,
    );
    // reply 第一条(r-1)释放一个槽位
    core.handleReply({ requestId: 'r-1', ok: true, result: 'done' });
    expect(core.pendingCount()).toBe(max - 1);
    // 现在能再接受一个,正常进 pending + 发 IPC
    const sendsBefore = send.mock.calls.length;
    void core.invoke(owner1, 'x', {});
    expect(core.pendingCount()).toBe(max);
    expect(send).toHaveBeenCalledTimes(sendsBefore + 1);
    // 再来一个又溢出
    err = await core.invoke(owner1, 'x', {}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS,
    );
  });

  it('per-wc 上限是 per-wc 的:owner1 满了,owner2(不同 wc)仍可 invoke', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const max = MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST;
    for (let i = 0; i < max; i++) void core.invoke(owner1, 'x', {});
    // owner1 溢出
    const e1 = await core.invoke(owner1, 'x', {}).catch((e: unknown) => e);
    expect((e1 as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS,
    );
    // owner2 不受影响
    void core.invoke(owner2, 'y', {});
    expect(core.pendingCount()).toBe(max + 1);
  });

  it('abort 整 wc 释放该 wc 全部在途槽位,之后该 wc 可重新 invoke 满额', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const max = MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST;
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < max; i++) ps.push(core.invoke(owner1, 'x', {}).catch(() => undefined));
    core.abortByWebContents(owner1.wcId); // 全摘 → per-wc 计数归零
    await Promise.all(ps);
    expect(core.pendingCount()).toBe(0);
    // 计数无残留:可再次凑满 max 个,第 max+1 个才溢出
    for (let i = 0; i < max; i++) void core.invoke(owner1, 'x', {});
    const err = await core.invoke(owner1, 'x', {}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS,
    );
  });

  it('全局上限:跨多个 wc 累计到全局上限后,新 wc 的 invoke 也被拒', async () => {
    const send = vi.fn();
    const { setTimer } = makeFakeTimerSetup();
    const core = createInvokeRemote({ send, setTimer, newRequestId: makeIdGen() });
    const perWc = MAX_INFLIGHT_INVOKES_PER_WC_FOR_TEST;
    const global = MAX_INFLIGHT_INVOKES_GLOBAL_FOR_TEST;
    // 用多个 wc,每个填到 per-wc 上限,直到逼近全局上限
    let filled = 0;
    let wcId = 1000;
    while (filled + perWc <= global) {
      const owner: PluginMcpToolOwner = { pluginId: 'p', wcId: wcId++ };
      for (let i = 0; i < perWc; i++) void core.invoke(owner, 'x', {});
      filled += perWc;
    }
    // 剩余补满到全局上限
    const lastOwner: PluginMcpToolOwner = { pluginId: 'p', wcId: wcId++ };
    while (filled < global) {
      void core.invoke(lastOwner, 'x', {});
      filled += 1;
    }
    expect(core.pendingCount()).toBe(global);
    // 全新 wc(per-wc 计数为 0)也应被全局闸拒
    const freshOwner: PluginMcpToolOwner = { pluginId: 'p', wcId: 999999 };
    const err = await core.invoke(freshOwner, 'x', {}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.TOO_MANY_REQUESTS,
    );
    expect(core.pendingCount()).toBe(global); // 没增
  });
});
