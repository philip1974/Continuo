// race(R32):plugin-mcp 反向 invoke 先登记 pending 再 send()。IPC 层 send 在
// webContents.fromId(owner.wcId) 已销毁时此前静默 return no-op → 该 pending 无人 abort,
// 外部 agent 的 tools/call 干等满 30s INVOKE_TIMEOUT 才自愈(登记 pending 与 send 之间窗口里
// destroyed-cleanup 可能已先跑完,abortByWebContents 扫不到这条更晚登记的 pending)。
// 修:send 返回 boolean(false=wc 已销毁/不可达),invoke 在 false / send 抛错时立即清 pending +
// cancel timer + reject PLUGIN_GONE,不等 timeout。返 void/true 视作已投递(向后兼容旧桩)。
import { describe, expect, it, vi } from 'vitest';
import { createInvokeRemote } from '../../../electron/main/services/plugin-mcp-bridge.service';
import { PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';

describe('race(R32) · plugin-mcp send 失败立即 reject 不挂起', () => {
  it('send 返回 false(wc 已销毁)→ 立即 reject PLUGIN_GONE + 清 pending + cancel timer', async () => {
    const timer = { cancel: vi.fn() };
    const core = createInvokeRemote({
      send: vi.fn(() => false),
      setTimer: () => timer,
      newRequestId: () => 'req-0',
    });

    const p = core.invoke({ pluginId: 'pid', wcId: 7 }, 'doThing', {});
    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE,
    });
    expect(core.pendingCount()).toBe(0);
    expect(timer.cancel).toHaveBeenCalled(); // 没留下等 30s 的 timer
  });

  it('send 抛错 → 立即 reject PLUGIN_GONE + 清 pending', async () => {
    const timer = { cancel: vi.fn() };
    const core = createInvokeRemote({
      send: vi.fn(() => {
        throw new Error('wc.send blew up');
      }),
      setTimer: () => timer,
      newRequestId: () => 'req-0',
    });

    const p = core.invoke({ pluginId: 'pid', wcId: 7 }, 'doThing', {});
    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE,
    });
    expect(core.pendingCount()).toBe(0);
    expect(timer.cancel).toHaveBeenCalled();
  });

  it('send 返回 true → 正常保持 pending,等 reply 结算(投递成功路径)', async () => {
    const core = createInvokeRemote({
      send: vi.fn(() => true),
      setTimer: () => ({ cancel: vi.fn() }),
      newRequestId: () => 'req-0',
    });

    const p = core.invoke({ pluginId: 'pid', wcId: 7 }, 'doThing', {});
    expect(core.pendingCount()).toBe(1);
    core.handleReply({ requestId: 'req-0', ok: true, result: 'done' });
    await expect(p).resolves.toBe('done');
  });

  it('send 返回 void(旧桩契约)→ 视作已投递,保持 pending(向后兼容)', async () => {
    const core = createInvokeRemote({
      send: vi.fn(), // 返回 undefined
      setTimer: () => ({ cancel: vi.fn() }),
      newRequestId: () => 'req-0',
    });

    const p = core.invoke({ pluginId: 'pid', wcId: 7 }, 'doThing', {});
    expect(core.pendingCount()).toBe(1);
    core.handleReply({ requestId: 'req-0', ok: true, result: 'ok' });
    await expect(p).resolves.toBe('ok');
  });
});
