// topic 49 · 审计 #4: renderer reload(Ctrl+R / HMR full reload)时 webContents 不
// 销毁、wcId 不变,但 renderer 侧 plugin registry 被清空重建。main 端必须在新文档
// 加载前(did-start-navigation)摘掉残留 MCP stub,否则旧 tool 调用 reject
// NO_SUCH_TOOL、重注册同名 throw TOOL_NAME_TAKEN。
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PLUGIN_MCP_CHANNELS } from '../../../electron/shared/plugin-mcp-channels';

// 捕获 ipcMain.handle/on 注册的 handler。
const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  },
  webContents: { fromId: () => null },
}));

// 绕过 frame 信任 + zod 包装,直接把 payload 喂给业务回调。
vi.mock('../../../electron/main/safe-handle', () => ({
  defaultIsTrustedFrame: () => true,
  processIpcCall: async (
    schema: { parse: (r: unknown) => unknown },
    cb: (p: unknown) => unknown,
    raw: unknown,
  ) => cb(schema.parse(raw)),
}));

import { startPluginMcpIpc } from '../../../electron/main/ipc/plugin-mcp.ipc';
import type { AnyMcpTool } from '../../../electron/main/services/mcp-host.service';

function makeFakeHost() {
  const tools = new Map<string, AnyMcpTool>();
  const removeCalls: string[] = [];
  return {
    tools,
    removeCalls,
    registerTool: (t: AnyMcpTool) => tools.set(t.name, t),
    removeTool: (name: string) => {
      removeCalls.push(name);
      tools.delete(name);
    },
    broadcast: () => {},
  };
}

function regPayload(name: string, pluginId = 'p') {
  return {
    pluginId,
    name,
    description: `${name} desc`,
    jsonSchema: { type: 'object', additionalProperties: false },
  };
}

let host: ReturnType<typeof makeFakeHost>;
let registerHandler: (...a: unknown[]) => unknown;

async function register(wc: EventEmitter & { id: number }, name: string): Promise<void> {
  await registerHandler(
    { sender: wc, senderFrame: {} },
    regPayload(name),
  );
}

function makeWc(id: number): EventEmitter & { id: number; isDestroyed: () => boolean } {
  const wc = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed: () => boolean;
  };
  wc.id = id;
  wc.isDestroyed = () => false;
  return wc;
}

describe('topic 49 · plugin reload 清理残留 MCP stub', () => {
  beforeAll(() => {
    host = makeFakeHost();
    startPluginMcpIpc(host as never);
    registerHandler = handlers.get(PLUGIN_MCP_CHANNELS.REGISTER)!;
  });

  afterEach(() => {
    host.removeCalls.length = 0;
  });

  it('main-frame 全页导航(reload)→ 摘掉该 wc 的 stub', async () => {
    const wc = makeWc(101);
    await register(wc, 'reload_tool');
    expect(host.tools.has('reload_tool')).toBe(true);

    // 模拟 reload:main frame 非同文档导航
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });

    expect(host.removeCalls).toContain('reload_tool');
    expect(host.tools.has('reload_tool')).toBe(false);
  });

  it('reload 后重注册同名 tool 不再撞 TOOL_NAME_TAKEN', async () => {
    const wc = makeWc(102);
    await register(wc, 'dup_tool');
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    // 新文档里重新注册同名 → 不抛
    await expect(register(wc, 'dup_tool')).resolves.toBeUndefined();
    expect(host.tools.has('dup_tool')).toBe(true);
  });

  it('同文档导航(hash / pushState)不摘 stub', async () => {
    const wc = makeWc(103);
    await register(wc, 'keep_tool');
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(host.removeCalls).not.toContain('keep_tool');
    expect(host.tools.has('keep_tool')).toBe(true);
  });

  it('子 frame 导航不摘 stub', async () => {
    const wc = makeWc(104);
    await register(wc, 'subframe_tool');
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(host.removeCalls).not.toContain('subframe_tool');
    expect(host.tools.has('subframe_tool')).toBe(true);
  });
});
