// BDD: workbench-editor-commands —— ⌘W 无可关面板时经 window:close 关闭发起方所在窗口。
// main 调 win.close()(不是 destroy / renderer window.close):触发 BrowserWindow 'close',走关窗脏确认。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  senderToWindow: new Map<object, { id: number; close: () => void; destroy: () => void }>(),
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
const win = { id: 7, close: vi.fn(), destroy: vi.fn() };

function invokeClose(from: object = sender): Promise<unknown> {
  const handler = electronMock.handlers.get(WINDOW_CHANNELS.CLOSE);
  if (!handler) throw new Error('missing window:close handler');
  return handler({ sender: from, senderFrame: TRUSTED_FRAME }, {});
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.handlers.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(sender, win);
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn() });
});

describe('window:close', () => {
  it('关闭发起方所在窗口(win.close,经关窗脏确认),不 destroy', async () => {
    const r = await invokeClose();
    expect(r).toEqual({ ok: true, data: undefined });
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it('发起方不对应任何窗口 → NO_WINDOW,不关别的窗口', async () => {
    const r = (await invokeClose({})) as { ok: boolean; code?: string };
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_WINDOW');
    expect(win.close).not.toHaveBeenCalled();
  });
});
