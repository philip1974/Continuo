// 第十一轮 · P2-AD plugin-mcp INVOKE_REPLY 校验 senderFrame 可信
//
// 同模块 REGISTER/UNREGISTER 都走 defaultIsTrustedFrame(event.senderFrame),
// 但旧 INVOKE_REPLY 的 ipcMain.on 丢弃 _event、不校验 frame → 不受信 frame
// (被注入的子 frame / 未来 iframe 插件隔离)可伪造 reply 提前 resolve 挂起的
// MCP invoke(虽有随机 UUID requestId 屏障)。修复:与其它通道对齐校验。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_MCP_CHANNELS } from '../../../electron/shared/plugin-mcp-channels';

const handlers = vi.hoisted(
  () => new Map<string, (...a: unknown[]) => unknown>(),
);
const trust = vi.hoisted(() => ({
  fn: vi.fn((frame: { url?: string }) => frame?.url?.startsWith('file://') ?? false),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  },
  webContents: { fromId: () => null },
}));

vi.mock('../../../electron/main/safe-handle', () => ({
  defaultIsTrustedFrame: (frame: { url?: string }) => trust.fn(frame),
  processIpcCall: async () => undefined,
}));

import { startPluginMcpIpc } from '../../../electron/main/ipc/plugin-mcp.ipc';

function makeFakeHost() {
  return {
    tools: new Map(),
    registerTool: () => {},
    removeTool: () => {},
    broadcast: () => {},
  };
}

let replyHandler: (...a: unknown[]) => unknown;

// 模块级单例:startPluginMcpIpc 只在首次注册 ipcMain handler,故 beforeAll 抓一次。
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  startPluginMcpIpc(makeFakeHost() as any);
  replyHandler = handlers.get(PLUGIN_MCP_CHANNELS.INVOKE_REPLY)!;
});

beforeEach(() => {
  trust.fn.mockClear();
});

describe('49 · INVOKE_REPLY 校验 senderFrame', () => {
  it('handler 用 event.senderFrame 调 defaultIsTrustedFrame', () => {
    const senderFrame = { url: 'file:///renderer/index.html' };
    replyHandler({ senderFrame }, { requestId: 'r1', ok: true, result: 1 });
    expect(trust.fn).toHaveBeenCalledWith(senderFrame);
  });

  it('不受信 frame → 提前返回,reply 不被解析路由(不抛)', () => {
    const evil = { url: 'https://evil.example/x' };
    // 即便 payload 合法,untrusted frame 也应被静默丢弃
    expect(() =>
      replyHandler({ senderFrame: evil }, { requestId: 'r1', ok: true, result: 1 }),
    ).not.toThrow();
    expect(trust.fn).toHaveReturnedWith(false);
  });
});
