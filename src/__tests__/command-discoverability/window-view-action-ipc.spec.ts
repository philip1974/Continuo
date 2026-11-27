// BDD: command-discoverability —— 命令面板里的「重新加载窗口 / 切换全屏」经 window:view-action
// 作用于发起方所在窗口(同应用菜单 View 的动作)。见同目录 README 第 2 条。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

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
const win = {
  id: 7,
  webContents: { zoomLevel: 0 },
  isFullScreen: vi.fn(() => fullScreen),
  setFullScreen: vi.fn((v: boolean) => {
    fullScreen = v;
  }),
};
const reloadWindow = vi.fn();

function invoke(raw: unknown, from: object = sender): Promise<unknown> {
  const handler = electronMock.handlers.get(WINDOW_CHANNELS.VIEW_ACTION);
  if (!handler) throw new Error('missing window:view-action handler');
  return handler({ sender: from, senderFrame: TRUSTED_FRAME }, raw);
}

beforeEach(() => {
  vi.clearAllMocks();
  fullScreen = false;
  win.webContents.zoomLevel = 0;
  electronMock.handlers.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(sender, win);
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow, rebuildAppMenu: vi.fn() });
});

describe('window:view-action', () => {
  it('reload → 交给注入的 reloadWindow(与菜单 ⌘R 同一的脏确认 + flush),作用于发起方窗口', async () => {
    expect(await invoke({ action: 'reload' })).toEqual({ ok: true, data: undefined });
    expect(reloadWindow).toHaveBeenCalledWith(win);
  });

  it('toggleFullScreen 在全屏 / 非全屏间切换', async () => {
    await invoke({ action: 'toggleFullScreen' });
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true);
    await invoke({ action: 'toggleFullScreen' });
    expect(win.setFullScreen).toHaveBeenLastCalledWith(false);
  });

  it('未知动作 / 多余字段 → 拒绝,不动窗口', async () => {
    // 缩放不再是窗口动作(改设置项 window.zoomLevel,所有窗口统一,见 src/__tests__/window-zoom/)
    for (const raw of [{ action: 'close' }, { action: 'zoomIn' }, { action: 'reload', extra: 1 }, {}]) {
      const r = (await invoke(raw)) as { ok: boolean };
      expect(r.ok).toBe(false);
    }
    expect(win.webContents.zoomLevel).toBe(0);
    expect(reloadWindow).not.toHaveBeenCalled();
  });

  it('发起方不对应任何窗口 → NO_WINDOW', async () => {
    const r = (await invoke({ action: 'reload' }, {})) as { ok: boolean; code?: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_WINDOW');
    expect(reloadWindow).not.toHaveBeenCalled();
  });
});
