// topic 49 第六 session · P2:plugin unregister tool 时 abort 该 tool 的在途 invoke。
//
// 根因:createPluginMcpBridge.handleUnregister 从 host/entries 摘掉 tool,但不 abort
// 该 tool 还在途的 invoke。对比 handleWebContentsGone 在摘 tool 后显式调
// invokeRemote.abortByWebContents —— 这条非对称。后果:plugin 动态 unregister 一个
// 正被 agent 调用的 tool 时,renderer 端 stub 已没,reply 永不回来,agent 侧
// tools/call 要干等满 30s INVOKE_TIMEOUT 才自愈。
// 修复:InvokeRemoteCore 加 abortByTool(wcId,name),handleUnregister 摘 tool 后调一次,
// reject code = TOOL_DISPOSED。是「守卫加在 handleWebContentsGone 漏了 handleUnregister
// 平行入口」高频缺陷类。

import { describe, expect, it, vi } from 'vitest';
import { createInvokeRemote } from '../../../electron/main/services/plugin-mcp-bridge.service';
import { PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';

function makeManualTimer() {
  // 不真起 30s 定时器;我们只验证 abortByTool 在 timeout 之前就结算。
  return { cancel: vi.fn() };
}

describe('topic49 6thS · InvokeRemoteCore.abortByTool', () => {
  it('abortByTool 立即 reject 匹配 (wcId,name) 的在途 invoke(不等 30s timeout)', async () => {
    const core = createInvokeRemote({
      send: vi.fn(),
      setTimer: () => makeManualTimer(),
      newRequestId: (() => {
        let n = 0;
        return () => `req-${n++}`;
      })(),
    });

    const p = core.invoke({ pluginId: 'pid', wcId: 7 }, 'doThing', {});
    expect(core.pendingCount()).toBe(1);

    core.abortByTool(7, 'doThing');

    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.TOOL_DISPOSED,
    });
    expect(core.pendingCount()).toBe(0);
  });

  it('只 abort 匹配的 tool/wc,其它在途 invoke 不受影响', async () => {
    const core = createInvokeRemote({
      send: vi.fn(),
      setTimer: () => makeManualTimer(),
      newRequestId: (() => {
        let n = 0;
        return () => `req-${n++}`;
      })(),
    });

    const pSame = core.invoke({ pluginId: 'pid', wcId: 7 }, 'doThing', {});
    const pOtherTool = core.invoke({ pluginId: 'pid', wcId: 7 }, 'other', {});
    const pOtherWc = core.invoke({ pluginId: 'pid', wcId: 9 }, 'doThing', {});
    expect(core.pendingCount()).toBe(3);

    core.abortByTool(7, 'doThing');

    await expect(pSame).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.TOOL_DISPOSED,
    });
    // 同 wc 不同 tool、同 tool 不同 wc 都仍 pending
    expect(core.pendingCount()).toBe(2);

    // 用 reply 正常结算其一,证明它没被误伤
    core.handleReply({ requestId: 'req-1', ok: true, result: 'ok' });
    await expect(pOtherTool).resolves.toBe('ok');
    void pOtherWc; // 仍 pending,留给 GC
  });
});
