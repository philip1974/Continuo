// BDD: popout-picker 第 2 条(main 侧)—— window:focus 激活发起方所在窗口(主窗 renderer 在 popout 子窗获焦时把面板 /
// 选择器打开在主窗后调用)。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';

type InvokeHandler = (event: { sender: object; senderFrame: unknown }, raw: unknown) => Promise<unknown>;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  senderToWindow: new Map<object, { id: number; focus: () => void }>(),
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
const win = { id: 7, focus: vi.fn() };

function invokeFocus(from: object = sender, raw: unknown = {}): Promise<unknown> {
  const handler = electronMock.handlers.get(WINDOW_CHANNELS.FOCUS);
  if (!handler) throw new Error('missing window:focus handler');
  return handler({ sender: from, senderFrame: TRUSTED_FRAME }, raw);
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.handlers.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(sender, win);
  registerWindowIpc({ createMainWindow: vi.fn(), relaunchApp: vi.fn(), reloadWindow: vi.fn(), rebuildAppMenu: vi.fn() });
});

describe('window:focus', () => {
  it('激活发起方所在窗口', async () => {
    expect(await invokeFocus()).toEqual({ ok: true, data: undefined });
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('发起方不对应任何窗口 → NO_WINDOW;多余字段 → 拒绝', async () => {
    const r = (await invokeFocus({})) as { ok: boolean; code?: string };
    expect(r).toMatchObject({ ok: false, code: 'NO_WINDOW' });
    expect(((await invokeFocus(sender, { id: 1 })) as { ok: boolean }).ok).toBe(false);
    expect(win.focus).not.toHaveBeenCalled();
  });
});
