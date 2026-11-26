// window:relaunch-app 交给组合根的 relaunchApp(走正常退出流程),不在 IPC 内直接 app.relaunch / exit。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  app: { getPath: vi.fn(() => '/tmp'), on: vi.fn(), relaunch: vi.fn(), exit: vi.fn(), quit: vi.fn() },
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../electron/main/persistence', () => ({ allocateWindowSeq: vi.fn() }));

const relaunchApp = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.handlers.clear();
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp, reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});

describe('window:relaunch-app', () => {
  it('调组合根 relaunchApp;不直接 app.relaunch / app.exit', async () => {
    const handler = electronMock.handlers.get(WINDOW_CHANNELS.RELAUNCH_APP)!;
    const r = await handler({ sender: {}, senderFrame: { url: 'file:///app/index.html' } }, {});
    expect(r).toEqual({ ok: true, data: undefined });
    expect(relaunchApp).toHaveBeenCalledTimes(1);
    expect(electronMock.app.relaunch).not.toHaveBeenCalled();
    expect(electronMock.app.exit).not.toHaveBeenCalled();
  });

  it('入参须为空对象(多余字段 → BAD_INPUT,不重启)', async () => {
    const handler = electronMock.handlers.get(WINDOW_CHANNELS.RELAUNCH_APP)!;
    const r = (await handler({ sender: {}, senderFrame: { url: 'file:///app/index.html' } }, { force: true })) as {
      ok: boolean;
    };
    expect(r.ok).toBe(false);
    expect(relaunchApp).not.toHaveBeenCalled();
  });
});
