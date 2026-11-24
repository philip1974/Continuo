// 冷启动 co:// 深链:main 只向「renderer 已上报协议监听就绪」的窗口投递,did-finish-load 不算就绪。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  drainOnProtocolReady,
  routeProtocolUrl,
  type ProtoWindow,
} from '../../../electron/main/protocol-dispatch';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';

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

const CH = PLUGINS_CHANNELS.PROTOCOL_URL;

function makeWin() {
  const send = vi.fn();
  const w: ProtoWindow & { ready: boolean } = {
    ready: false,
    isDestroyed: () => false,
    // 文档已 load 完成(旧判定会视为就绪),但 renderer 尚未上报协议监听就绪。
    webContents: Object.assign({ send }, { isLoading: () => false }),
  };
  return { w, send };
}

const isReady = (w: ProtoWindow) => (w as ProtoWindow & { ready: boolean }).ready;

describe('co:// 协议监听就绪握手 · main 路由', () => {
  it('did-finish-load 后尚未上报就绪 → 不投递,深链排队', () => {
    const { w, send } = makeWin();
    const pending: string[] = [];
    routeProtocolUrl('co://run/cold', { windows: [w], channel: CH, pending, isReady });
    expect(send).not.toHaveBeenCalled();
    expect(pending).toEqual(['co://run/cold']);
  });

  it('上报就绪后按 FIFO 排空队列,之后的深链直接投递', () => {
    const { w, send } = makeWin();
    const pending: string[] = [];
    routeProtocolUrl('co://run/1', { windows: [w], channel: CH, pending, isReady });
    routeProtocolUrl('co://run/2', { windows: [w], channel: CH, pending, isReady });
    expect(send).not.toHaveBeenCalled();

    w.ready = true;
    drainOnProtocolReady(w, CH, pending);
    expect(send.mock.calls.map((c) => c[1])).toEqual([{ url: 'co://run/1' }, { url: 'co://run/2' }]);
    expect(pending).toEqual([]);

    routeProtocolUrl('co://run/3', { windows: [w], channel: CH, pending, isReady });
    expect(send).toHaveBeenLastCalledWith(CH, { url: 'co://run/3' });
    expect(pending).toEqual([]);
  });
});

describe('co:// 协议监听就绪握手 · preload 上报', () => {
  it('onProtocolUrl 先挂监听,再上报 plugins:protocol-ready', async () => {
    vi.resetModules();
    const electron = await import('electron');
    await import('../../../electron/preload/index');
    const bridge = vi.mocked(electron.contextBridge.exposeInMainWorld).mock.calls.find(
      (c) => c[0] === '__lmApi',
    )?.[1] as { claimRendererApi: () => unknown };
    const exposed = bridge.claimRendererApi() as {
      plugins: { onProtocolUrl: (cb: (url: string) => void) => () => void };
    };
    const on = vi.mocked(electron.ipcRenderer.on);
    const send = vi.mocked(electron.ipcRenderer.send);
    on.mockClear();
    send.mockClear();

    exposed.plugins.onProtocolUrl(() => {});

    const onOrder = on.mock.invocationCallOrder[on.mock.calls.findIndex((c) => c[0] === CH)];
    const readyIdx = send.mock.calls.findIndex((c) => c[0] === PLUGINS_CHANNELS.PROTOCOL_READY);
    expect(onOrder).toBeDefined();
    expect(readyIdx).toBeGreaterThanOrEqual(0);
    expect(send.mock.invocationCallOrder[readyIdx]!).toBeGreaterThan(onOrder!);
  });
});

describe('co:// 协议监听就绪握手 · main 接线', () => {
  const indexSrc = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../electron/main/index.ts'),
    'utf8',
  );

  it('PROTOCOL_READY 处理器校验受信 frame 与发送方窗口,就绪后排空队列', () => {
    const start = indexSrc.indexOf('ipcMain.on(PLUGINS_CHANNELS.PROTOCOL_READY');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = indexSrc.slice(start, start + 800);
    // trustedSenderWindow:受信 frame + 发送方正是该窗口的主 webContents(行为见 safe-handle 单测)。
    expect(body).toContain('trustedSenderWindow(event)');
    expect(body).toContain('drainOnProtocolReady(');
  });

  it('路由按就绪集合判定,文档换掉(提交导航 / 崩溃 / 主框架加载失败)后就绪作废;不再在 did-finish-load 排空', () => {
    expect(indexSrc).toMatch(/isReady:\s*\(w\)\s*=>\s*protocolReadyContents\.has\(w\.webContents\)/);
    // 作废判定与 agent 授权共用 lib/renderer-document-gone(其行为由 renderer-document-gone.test 覆盖)。
    expect(indexSrc).toMatch(
      /onRendererDocumentGone\(win\.webContents,\s*\(\)\s*=>\s*protocolReadyContents\.delete/,
    );
    expect(indexSrc).not.toContain('attachWindowDrain(');
  });
});
