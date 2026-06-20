// topic 49 第十二 session · codex 复审 loop R20-confirm:plugin-mcp 生产 IPC 入口必须把畸形 reply 交给 handleReply。
//
// 根因:createInvokeRemote.handleReply 已实现「带 requestId 但 ok 畸形 → 立即 reject INVALID_REPLY」
// (第七 session 硬化),但**只有单元测试覆盖**。生产 INVOKE_REPLY IPC 入口先 `InvokeReplySchema.safeParse`
// + `if (!parsed.success) return` 静默丢弃畸形 payload → handleReply 的 INVALID_REPLY 立即-reject 路径
// 在生产不可达 → 对应 pending invoke 干等满 30s timeout(外部 agent tools/call 看起来卡死)。
// 「helper 正确但生产入口绕过 helper」的闭环遗漏。
//
// 修:schema 失败的 reply 仍交给 handleReply(它对 raw 全防御),让畸形带 requestId 的立即 reject;
// 无 requestId 的垃圾仍由 handleReply 内部丢弃。本 spec 走**真实 IPC handler**(startPluginMcpIpc 注的
// ipcMain.on(INVOKE_REPLY))驱动,而非直接调 core —— 证生产路径不再绕过 helper。

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (event: unknown, raw: unknown) => void;

const electronMock = vi.hoisted(() => ({
  onHandlers: new Map<string, Handler>(),
  sentFromWc: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: Handler) => electronMock.onHandlers.set(channel, fn),
  },
  webContents: {
    fromId: () => ({
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) =>
        electronMock.sentFromWc.push({ channel, payload }),
    }),
  },
}));

import { startPluginMcpIpc } from '../../../electron/main/ipc/plugin-mcp.ipc';
import { PLUGIN_MCP_CHANNELS, PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';

function fakeHost() {
  return {
    registerTool: vi.fn(),
    removeTool: vi.fn(),
    tools: new Map(),
    broadcast: vi.fn(),
  } as never;
}

const trustedEvent = { senderFrame: { url: 'file:///app/index.html' } };

beforeEach(() => {
  electronMock.sentFromWc.length = 0;
});

describe('topic49 codex-loop R20 · plugin-mcp 生产入口畸形 reply 达 helper', () => {
  it('INVOKE_REPLY handler 收到带 requestId 但 ok 畸形的 reply → 立即 reject INVALID_REPLY(不等 30s)', async () => {
    const { invokeRemote } = startPluginMcpIpc(fakeHost());
    const replyHandler = electronMock.onHandlers.get(PLUGIN_MCP_CHANNELS.INVOKE_REPLY)!;
    expect(replyHandler).toBeDefined();

    // 发起一个 invoke → 挂 pending,并经 webContents.send 发出 INVOKE(含 requestId)
    const p = invokeRemote.invoke({ pluginId: 'p', wcId: 1 }, 'tool', { x: 1 });
    const invokeSend = electronMock.sentFromWc.find(
      (s) => s.channel === PLUGIN_MCP_CHANNELS.INVOKE,
    )!;
    const reqId = (invokeSend.payload as { requestId: string }).requestId;

    // 生产 IPC 入口收到畸形 reply(有 requestId,但 ok 缺失/result 乱填)
    replyHandler(trustedEvent, { requestId: reqId, result: 'oops' });

    // 关键:立即 reject INVALID_REPLY,而不是被 schema-gate 丢弃后干等 30s timeout
    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
    });
    expect(invokeRemote.pendingCount()).toBe(0);
  });

  it('合法 reply 仍正常 resolve(schema fast-path 不破)', async () => {
    const { invokeRemote } = startPluginMcpIpc(fakeHost());
    const replyHandler = electronMock.onHandlers.get(PLUGIN_MCP_CHANNELS.INVOKE_REPLY)!;

    const p = invokeRemote.invoke({ pluginId: 'p', wcId: 1 }, 'tool', { x: 2 });
    const invokeSend = electronMock.sentFromWc.find(
      (s) => s.channel === PLUGIN_MCP_CHANNELS.INVOKE,
    )!;
    const reqId = (invokeSend.payload as { requestId: string }).requestId;

    replyHandler(trustedEvent, { requestId: reqId, ok: true, result: { done: true } });
    await expect(p).resolves.toEqual({ done: true });
  });
});
