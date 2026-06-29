// 边界(E257,E255/E256 同族):plugin-mcp invoke-reply raw ipcMain.on 绕过 safeHandle 预检,直接
// InvokeReplySchema.safeParse(raw)。该 schema 是 strict discriminated union,畸形 reply 海量未知短 key
// 仍会先触发 Zod 枚举 + 构造 unknown-keys issue 放大。修:safeParse 前 boundedObjectAdmissible 预检,
// 超限不进 Zod 但仍交 handleReply(O(1) 读 requestId),让 pending invoke 立即 reject 不等 30s。
// 走真实 IPC handler(startPluginMcpIpc 注的 ipcMain.on)驱动,证生产路径预检生效且不挂起。
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
import {
  PLUGIN_MCP_CHANNELS,
  PLUGIN_MCP_ERROR_CODES,
} from '../../../electron/shared/plugin-mcp-channels';
import { MAX_BOUNDED_OBJECT_KEYS } from '../../../electron/shared/bounded-input';
import { InvokeReplySchema } from '../../../electron/shared/plugin-mcp-schemas';

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

describe('E257 plugin-mcp invoke-reply bounded 预检', () => {
  it('海量未知 key 的 reply(带 requestId)→ 不进 Zod 但仍 reject INVALID_REPLY(不挂 30s)', async () => {
    const { invokeRemote } = startPluginMcpIpc(fakeHost());
    const replyHandler = electronMock.onHandlers.get(
      PLUGIN_MCP_CHANNELS.INVOKE_REPLY,
    )!;
    expect(replyHandler).toBeDefined();

    const p = invokeRemote.invoke({ pluginId: 'p', wcId: 1 }, 'tool', { x: 1 });
    const invokeSend = electronMock.sentFromWc.find(
      (s) => s.channel === PLUGIN_MCP_CHANNELS.INVOKE,
    )!;
    const reqId = (invokeSend.payload as { requestId: string }).requestId;

    // 畸形 reply:合法 requestId,但塞超过 cap 的未知短 key + ok 缺失 → 预检拦下不进 Zod,
    // handleReply 仍按 requestId 立即 reject INVALID_REPLY。
    const evil: Record<string, unknown> = { requestId: reqId };
    for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) evil[`u${i}`] = 1;

    // 关键(neutralize 敏感):预检拦下 → 不调 InvokeReplySchema.safeParse(不进 Zod 枚举放大)。
    // 若去掉预检,safeParse 会被调用(随后 fallback handleReply 同样 reject,outcome 相同),故仅
    // 凭 reject 结果无法区分;靠 safeParse 调用次数证明"未进 Zod"。
    const spy = vi.spyOn(InvokeReplySchema, 'safeParse');
    replyHandler(trustedEvent, evil);

    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
    });
    expect(invokeRemote.pendingCount()).toBe(0);
    expect(spy).not.toHaveBeenCalled(); // 超限 payload 从未进入 Zod
    spy.mockRestore();
  });

  it('合法 reply 仍正常 resolve(预检 fast-path 不破)', async () => {
    const { invokeRemote } = startPluginMcpIpc(fakeHost());
    const replyHandler = electronMock.onHandlers.get(
      PLUGIN_MCP_CHANNELS.INVOKE_REPLY,
    )!;

    const p = invokeRemote.invoke({ pluginId: 'p', wcId: 1 }, 'tool', { x: 2 });
    const invokeSend = electronMock.sentFromWc.find(
      (s) => s.channel === PLUGIN_MCP_CHANNELS.INVOKE,
    )!;
    const reqId = (invokeSend.payload as { requestId: string }).requestId;

    replyHandler(trustedEvent, {
      requestId: reqId,
      ok: true,
      result: { done: true },
    });
    await expect(p).resolves.toEqual({ done: true });
  });

  // 边界(E265,E263 main 侧对偶 / 读端独立校验):schema 失败的 reply 不再整体交 handleReply(信任 raw
  // ok/result/message/code)。改按 requestId 固定 INVALID_REPLY 收口,绝不传播 raw 超大 result / 超长 message。
  it('E265 ok:false + 超长 message(>8192,schema 失败)→ INVALID_REPLY,不传播超长 message', async () => {
    const { invokeRemote } = startPluginMcpIpc(fakeHost());
    const replyHandler = electronMock.onHandlers.get(
      PLUGIN_MCP_CHANNELS.INVOKE_REPLY,
    )!;
    const p = invokeRemote.invoke({ pluginId: 'p', wcId: 1 }, 'tool', { x: 1 });
    const reqId = (
      electronMock.sentFromWc.find(
        (s) => s.channel === PLUGIN_MCP_CHANNELS.INVOKE,
      )!.payload as { requestId: string }
    ).requestId;

    const hugeMsg = 'm'.repeat(8192 + 5000);
    replyHandler(trustedEvent, {
      requestId: reqId,
      ok: false,
      code: 'PLUGIN_X',
      message: hugeMsg,
    });

    const err = await p.then(
      () => {
        throw new Error('expected invoke reply to reject');
      },
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.INVALID_REPLY);
    // 关键:固定错误串,不传播插件超长 message(防 mcp-host 编进 JSON-RPC 放大)
    expect(err.message).not.toContain('m'.repeat(8192));
    expect(err.message.length).toBeLessThan(200);
    expect(invokeRemote.pendingCount()).toBe(0);
  });

  it('E265 ok:true + 超大 result(>10MB,schema 失败)→ INVALID_REPLY,不 resolve 超大 result', async () => {
    const { invokeRemote } = startPluginMcpIpc(fakeHost());
    const replyHandler = electronMock.onHandlers.get(
      PLUGIN_MCP_CHANNELS.INVOKE_REPLY,
    )!;
    const p = invokeRemote.invoke({ pluginId: 'p', wcId: 1 }, 'tool', { x: 1 });
    const reqId = (
      electronMock.sentFromWc.find(
        (s) => s.channel === PLUGIN_MCP_CHANNELS.INVOKE,
      )!.payload as { requestId: string }
    ).requestId;

    const hugeResult = { blob: 'x'.repeat(10 * 1024 * 1024 + 16) }; // >10MB → schema 失败
    replyHandler(trustedEvent, { requestId: reqId, ok: true, result: hugeResult });

    // 不 resolve 超大 result,而是 reject INVALID_REPLY(超大 result 不经 pending 传播)
    await expect(p).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_REPLY,
    });
    expect(invokeRemote.pendingCount()).toBe(0);
  });
});
