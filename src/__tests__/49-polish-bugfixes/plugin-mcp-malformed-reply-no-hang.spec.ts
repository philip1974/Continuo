// P2 未闭环回归(第七 session R2):createInvokeRemote.handleReply 在判断 ok 之前
// 就 `pending.delete(requestId)` + `entry.timer.cancel()`。若插件 host 回的 reply
// 的 `ok` 既非 true 也非 false(缺失 / null / 字符串 "true" / 数字),原实现两个 if
// 都不命中 → 直接 return,**既不 resolve 也不 reject,且 timeout 已被 cancel**
// → 该 invoke 永久挂起,agent 的 MCP tools/call 永不返回。
//
// 修复:畸形 reply 显式 reject(code=INVALID_REPLY)。
import { describe, it, expect } from 'vitest';
import {
  createInvokeRemote,
  type CreateInvokeRemoteDeps,
  type PluginMcpToolOwner,
} from '../../../electron/main/services/plugin-mcp-bridge.service';
import { PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';

interface FakeTimer {
  fn: () => void;
  cancelled: boolean;
}

function makeSetup() {
  const timers: FakeTimer[] = [];
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const setTimer: NonNullable<CreateInvokeRemoteDeps['setTimer']> = (fn) => {
    const t: FakeTimer = { fn, cancelled: false };
    timers.push(t);
    return {
      cancel() {
        t.cancelled = true;
      },
    };
  };
  let n = 0;
  const deps: CreateInvokeRemoteDeps = {
    send: (_owner, channel, payload) => sent.push({ channel, payload }),
    setTimer,
    newRequestId: () => `req-${++n}`,
  };
  return { timers, sent, deps };
}

const OWNER: PluginMcpToolOwner = { pluginId: 'p', wcId: 1 };

describe('49 · plugin-mcp 畸形 reply 不挂起', () => {
  it('reply 缺 ok 字段 → reject INVALID_REPLY(不永久挂起)', async () => {
    const { sent, deps } = makeSetup();
    const core = createInvokeRemote(deps);

    const p = core.invoke(OWNER, 'tool', { x: 1 });
    const reqId = (sent[0]!.payload as { requestId: string }).requestId;

    // 模拟插件 host 回了畸形 reply:有 requestId 但没有 ok。
    core.handleReply({ requestId: reqId, result: 'oops' });

    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
    });
    expect(core.pendingCount()).toBe(0);
  });

  it('reply 的 ok 是字符串 "true"(类型错) → reject INVALID_REPLY', async () => {
    const { sent, deps } = makeSetup();
    const core = createInvokeRemote(deps);
    const p = core.invoke(OWNER, 'tool', {});
    const reqId = (sent[0]!.payload as { requestId: string }).requestId;
    core.handleReply({ requestId: reqId, ok: 'true', result: 'x' });
    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
    });
  });

  it('畸形 reply 处理后定时器已 cancel —— 证明无 timeout 兜底,必须靠 reject 闭环', async () => {
    const { sent, timers, deps } = makeSetup();
    const core = createInvokeRemote(deps);
    const p = core.invoke(OWNER, 'tool', {});
    const reqId = (sent[0]!.payload as { requestId: string }).requestId;
    core.handleReply({ requestId: reqId }); // 既无 ok 也无 result
    // 该请求的 timer 已被 cancel:若没有显式 reject,promise 将永久挂起。
    expect(timers[0]!.cancelled).toBe(true);
    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
    });
  });

  it('正常 reply 不受影响:ok=true 仍 resolve,ok=false 仍 reject 透传 code', async () => {
    const { sent, deps } = makeSetup();
    const core = createInvokeRemote(deps);

    const p1 = core.invoke(OWNER, 'tool', {});
    const id1 = (sent[0]!.payload as { requestId: string }).requestId;
    core.handleReply({ requestId: id1, ok: true, result: 42 });
    await expect(p1).resolves.toBe(42);

    const p2 = core.invoke(OWNER, 'tool', {});
    const id2 = (sent[1]!.payload as { requestId: string }).requestId;
    core.handleReply({ requestId: id2, ok: false, code: 'INVALID_PARAMS', message: 'bad' });
    await expect(p2).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
