// BDD: title-bar —— macOS 标题栏的全屏状态来源:window:is-full-screen 查询发起方窗口;进入 / 退出全屏 main 推送
// window:full-screen-changed。见同目录 README「红绿灯留位」。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc, wireFullScreenNotify } from '../../../electron/main/ipc/window.ipc';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  senderToWindow: new Map<object, unknown>(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => electronMock.senderToWindow.get(sender) ?? null),
    getAllWindows: vi.fn(() => []),
  },
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));

const TRUSTED_FRAME = { url: 'file:///app/index.html' };
const sender = {};
let fullScreen = false;
const win = { isFullScreen: vi.fn(() => fullScreen) };

function invoke(raw: unknown, from: object = sender): Promise<unknown> {
  const handler = electronMock.handlers.get(WINDOW_CHANNELS.IS_FULL_SCREEN);
  if (!handler) throw new Error('missing window:is-full-screen handler');
  return handler({ sender: from, senderFrame: TRUSTED_FRAME }, raw);
}

beforeEach(() => {
  vi.clearAllMocks();
  fullScreen = false;
  electronMock.handlers.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(sender, win);
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});

describe('window:is-full-screen', () => {
  it('返回发起方窗口当前是否全屏', async () => {
    expect(await invoke({})).toEqual({ ok: true, data: false });
    fullScreen = true;
    expect(await invoke({})).toEqual({ ok: true, data: true });
  });

  it('多余字段 → 拒绝;发起方不对应任何窗口 → NO_WINDOW', async () => {
    expect(((await invoke({ x: 1 })) as { ok: boolean }).ok).toBe(false);
    const r = (await invoke({}, {})) as { ok: boolean; code?: string };
    expect(r).toMatchObject({ ok: false, code: 'NO_WINDOW' });
  });
});

describe('wireFullScreenNotify', () => {
  it('进入 / 退出全屏 → 向该窗口推送 window:full-screen-changed(现在是否全屏)', () => {
    const listeners = new Map<string, () => void>();
    const send = vi.fn();
    let fs = false;
    const w = {
      on: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
      isFullScreen: () => fs,
      isDestroyed: () => false,
      webContents: { send },
    };
    wireFullScreenNotify(w as unknown as BrowserWindow);
    fs = true;
    listeners.get('enter-full-screen')!();
    expect(send).toHaveBeenLastCalledWith(WINDOW_CHANNELS.FULL_SCREEN_CHANGED, true);
    fs = false;
    listeners.get('leave-full-screen')!();
    expect(send).toHaveBeenLastCalledWith(WINDOW_CHANNELS.FULL_SCREEN_CHANGED, false);
  });
});
