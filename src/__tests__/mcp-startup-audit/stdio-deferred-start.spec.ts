// 冷启动性能:stdio MCP socket server(mkdir/stat/lstat/unlink/listen/chmod 串行)不再挡在建首窗前。
// 首窗与 PTY env 只依赖 HTTP host;stdio 配置只在 StatusBar「复制 MCP 配置」点击时读(未就绪 →
// getStdioConfig 默认 { available:false } → 按钮显示 unavailable)。
// 插件 tool 集变更广播须在 stdio 就绪前安全(只推 HTTP)、就绪后同时推 stdio。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLUGIN_MCP_CHANNELS } from '../../../electron/shared/plugin-mcp-channels';

const handlers = vi.hoisted(() => new Map<string, (...a: unknown[]) => unknown>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
  },
  webContents: { fromId: () => null },
}));

vi.mock('../../../electron/main/safe-handle', () => ({
  defaultIsTrustedFrame: () => true,
  safeHandleWithCtx: (
    ch: string,
    schema: { parse: (r: unknown) => unknown },
    cb: (p: unknown, ctx: { event: unknown }) => unknown,
  ) => handlers.set(ch, async (event: unknown, raw: unknown) => cb(schema.parse(raw), { event })),
}));

import { startPluginMcpIpc } from '../../../electron/main/ipc/plugin-mcp.ipc';
import { getStdioConfig } from '../../../electron/main/services/mcp-stdio-config.service';
import type { StdioSocketServer } from '../../../electron/main/services/mcp-stdio-server.service';

const LIST_CHANGED = 'notifications/tools/list_changed';

describe('stdio 就绪前后的插件 tool list_changed 广播', () => {
  const hostBroadcast = vi.fn();
  const stdioBroadcast = vi.fn();
  let stdioRef: StdioSocketServer | null = null;
  let register: (name: string) => Promise<unknown>;

  beforeAll(() => {
    vi.useFakeTimers();
    const tools = new Map();
    const host = {
      tools,
      registerTool: (t: { name: string }) => tools.set(t.name, t),
      removeTool: (n: string) => tools.delete(n),
      broadcast: hostBroadcast,
    };
    startPluginMcpIpc(host as never, () => stdioRef);
    const h = handlers.get(PLUGIN_MCP_CHANNELS.REGISTER)!;
    const wc = { id: 7, once: () => {}, on: () => {}, isDestroyed: () => false };
    register = (name) =>
      Promise.resolve(
        h({ sender: wc, senderFrame: {} }, {
          pluginId: 'p',
          name,
          description: 'd',
          jsonSchema: { type: 'object' },
        }),
      );
  });

  afterEach(() => {
    hostBroadcast.mockClear();
    stdioBroadcast.mockClear();
  });

  it('stdio 未就绪:只推 HTTP host,不抛', async () => {
    await register('before_ready');
    await vi.advanceTimersByTimeAsync(100);
    expect(hostBroadcast).toHaveBeenCalledWith(LIST_CHANGED);
    expect(stdioBroadcast).not.toHaveBeenCalled();
  });

  it('stdio 就绪后:同时推 stdio(读取的是最新引用,而非注册时快照)', async () => {
    stdioRef = { broadcast: stdioBroadcast } as unknown as StdioSocketServer;
    await register('after_ready');
    await vi.advanceTimersByTimeAsync(100);
    expect(hostBroadcast).toHaveBeenCalledWith(LIST_CHANGED);
    expect(stdioBroadcast).toHaveBeenCalledWith(LIST_CHANGED);
  });

  it('stdio 未就绪时「复制 MCP 配置」读到 available:false(StatusBar 走 unavailable 分支)', () => {
    expect(getStdioConfig()).toEqual({});
  });
});

describe('index.ts 启动接线(源码钉:依赖整套 Electron 启动)', () => {
  const src = readFileSync(join(process.cwd(), 'electron/main/index.ts'), 'utf8');
  const ready = src.slice(src.indexOf('app.whenReady().then('));

  it('stdio 不在建首窗前 await;在首窗创建之后 void 启动', () => {
    expect(src).not.toMatch(/await startMcpStdioServer\(\)/);
    const firstWindow = ready.indexOf('createMainWindow({');
    const stdioStart = ready.indexOf('startMcpStdioServer()');
    expect(firstWindow).toBeGreaterThan(0);
    expect(stdioStart).toBeGreaterThan(firstWindow);
  });

  it('插件 bridge 拿 stdio 取值函数而非启动时快照', () => {
    // 第三参为插件工具 agent 授权门控(requestAgentAuth)。
    expect(src).toMatch(/startPluginMcpIpc\(mcpHost, \(\) => mcpStdio, /);
  });

  it('退出清理先等 stdio 启动结束再 close(避免 listen 晚于 close 残留 socket)', () => {
    expect(src).toMatch(/traced\('mcp-stdio', [^)]*mcpStdioStarting[\s\S]{0,80}mcpStdio\?\.close\(\)/);
  });
});
