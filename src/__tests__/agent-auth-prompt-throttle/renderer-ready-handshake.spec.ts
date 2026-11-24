// agent 授权「renderer 就绪」握手的接线:preload 在授权请求的订阅建立后上报,main 按发送方窗口记为就绪,并在窗口
// 创建时(首次加载之前)开始跟踪。就绪前请求被拒的行为见 renderer-reload.spec.ts。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_AUTH_CHANNELS } from '../../../electron/shared/agent-auth-channels';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(() => 1),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));

const mainDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../electron/main');

describe('agent 授权就绪握手 · preload 上报', () => {
  it('agentAuth.onRequest 先挂监听,再上报 agent-auth:ready', async () => {
    vi.resetModules();
    const electron = await import('electron');
    await import('../../../electron/preload/index');
    const bridge = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls.find(
      (c) => c[0] === '__lmApi',
    )?.[1] as { claimRendererApi: () => unknown };
    const exposed = bridge.claimRendererApi() as {
      agentAuth: { onRequest: (cb: (payload: unknown) => void) => () => void };
    };
    const on = vi.mocked(electron.ipcRenderer.on);
    const send = vi.mocked(electron.ipcRenderer.send);
    on.mockClear();
    send.mockClear();

    exposed.agentAuth.onRequest(() => {});

    const onOrder =
      on.mock.invocationCallOrder[on.mock.calls.findIndex((c) => c[0] === AGENT_AUTH_CHANNELS.REQUEST)];
    const readyIdx = send.mock.calls.findIndex((c) => c[0] === AGENT_AUTH_CHANNELS.READY);
    expect(onOrder).toBeDefined();
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(send.mock.invocationCallOrder[readyIdx]!).toBeGreaterThan(onOrder!);
  });
});

describe('agent 授权就绪握手 · main 接线', () => {
  it('READY 处理器校验受信 frame,按发送方所在窗口记为就绪(不信 renderer 自报的窗口)', () => {
    const src = readFileSync(path.join(mainDir, 'index.ts'), 'utf8');
    const start = src.indexOf('ipcMain.on(AGENT_AUTH_CHANNELS.READY');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, start + 400);
    // trustedSenderWindow:受信 frame + 发送方正是该窗口的主 webContents(行为见 safe-handle 单测)。
    expect(body).toContain('trustedSenderWindow(event)');
    expect(body).toContain('markAgentAuthRendererReady(win.id)');
  });

  it('窗口创建时(browser-window-created)即开始跟踪 renderer 是否就绪', () => {
    const src = readFileSync(path.join(mainDir, 'index.ts'), 'utf8');
    const start = src.indexOf("app.on('browser-window-created'");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(src.slice(start, start + 900)).toContain('watchAgentAuthRenderer(win)');
  });
});
