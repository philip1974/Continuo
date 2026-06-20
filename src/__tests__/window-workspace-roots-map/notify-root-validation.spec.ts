import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { IPC_ERR } from '../../../electron/shared/ipc-result';
import { registerWindowIpc } from '../../../electron/main/ipc/window.ipc';
import {
  _reset,
  clearWindow,
  getWorkspaceRoot,
  setWorkspaceRoot,
} from '../../../electron/main/services/window-workspace-roots.service';

type Listener = (...args: unknown[]) => void;
type InvokeHandler = (event: { sender: object }, raw: unknown) => unknown;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  appListeners: new Map<string, Listener[]>(),
  senderToWindow: new Map<object, { id: number }>(),
}));

const serviceMock = vi.hoisted(() => {
  const map = new Map<number, string>();
  return {
    _reset: vi.fn(() => map.clear()),
    setWorkspaceRoot: vi.fn((windowId: number, root: string | null) => {
      if (root === null) {
        map.delete(windowId);
        return;
      }
      map.set(windowId, root);
    }),
    getWorkspaceRoot: vi.fn((windowId: number) => map.get(windowId) ?? null),
    clearWindow: vi.fn((windowId: number) => {
      map.delete(windowId);
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    on: vi.fn((event: string, listener: Listener) => {
      const listeners = electronMock.appListeners.get(event) ?? [];
      listeners.push(listener);
      electronMock.appListeners.set(event, listeners);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => {
      return electronMock.senderToWindow.get(sender) ?? null;
    }),
  },
}));

vi.mock('../../../electron/main/index', () => ({
  createMainWindow: vi.fn(),
}));

vi.mock('../../../electron/main/persistence', () => ({
  allocateWindowSeq: vi.fn(),
}));

vi.mock('../../../electron/main/services/window-workspace-roots.service', () => ({
  _reset: serviceMock._reset,
  clearWindow: serviceMock.clearWindow,
  getWorkspaceRoot: serviceMock.getWorkspaceRoot,
  setWorkspaceRoot: serviceMock.setWorkspaceRoot,
}));

const sender = {};
const fakeWindow = { id: 42 };
// 默认 trusted frame(file:// → defaultIsTrustedFrame 返回 true),让校验类用例正常走到
// 业务逻辑;codex-loop R7 给 NOTIFY_ROOT 加了 trusted-frame 门(见下方 R7 用例)。
const TRUSTED_FRAME = { url: 'file:///app/index.html' };

function eventFor(
  senderObject: object = sender,
  senderFrame: unknown = TRUSTED_FRAME,
): { sender: object; senderFrame: unknown } {
  return { sender: senderObject, senderFrame };
}

function notify(raw: unknown, senderFrame: unknown = TRUSTED_FRAME): unknown {
  const handler = electronMock.handlers.get(WINDOW_CHANNELS.NOTIFY_ROOT);
  if (!handler) throw new Error('missing notifyRoot handler');
  return handler(eventFor(sender, senderFrame), raw);
}

function browserWindowCreatedListener(): Listener {
  const listener = electronMock.appListeners.get('browser-window-created')?.[0];
  if (!listener) throw new Error('missing browser-window-created listener');
  return listener;
}

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.appListeners.clear();
  electronMock.senderToWindow.clear();
  electronMock.senderToWindow.set(sender, fakeWindow);
  _reset();
  vi.clearAllMocks();
  electronMock.senderToWindow.set(sender, fakeWindow);
  registerWindowIpc();
});

describe('window-workspace-roots-map: NotifyRoot validation', () => {
  it("T7: rejects relative root as BAD_ROOT with an 'absolute' message", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = notify({ root: './x' });

    expect(result).toEqual({
      ok: false,
      code: 'BAD_ROOT',
      message: 'root must be absolute non-empty path',
    });
    expect((result as { message: string }).message).toContain('absolute');
    warn.mockRestore();
  });

  it('T7b: rejected BAD_ROOT calls warn once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    notify({ root: './x' });

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('T7c: rejected NotifyRoot result includes a non-empty message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = notify({ root: './x' });

    expect(result).toMatchObject({ ok: false, code: 'BAD_ROOT' });
    expect((result as { message?: string }).message).toEqual(
      expect.any(String),
    );
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('T7d: rejected NotifyRoot warn includes the window id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    notify({ root: './x' });

    expect(warn.mock.calls[0]).toContain(42);
    warn.mockRestore();
  });

  it('T8: rejects empty string root as semantic BAD_ROOT', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = notify({ root: '' });

    expect(result).toMatchObject({ ok: false, code: 'BAD_ROOT' });
    warn.mockRestore();
  });

  it.each([42, {}, undefined])(
    'T9: rejects non-string root shape as BAD_INPUT: %s',
    (root) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = notify(root === undefined ? undefined : { root });

      expect(result).toMatchObject({
        ok: false,
        code: 'BAD_INPUT',
        message: 'invalid input shape',
      });
      warn.mockRestore();
    },
  );

  it('T10: accepts an absolute root and stores it for the sender window', () => {
    const result = notify({ root: '/abs' });

    expect(result).toEqual({ ok: true });
    expect(setWorkspaceRoot).toHaveBeenCalledWith(42, '/abs');
  });

  it('T11: accepts null and stores it for the sender window', () => {
    const result = notify({ root: null });

    expect(result).toEqual({ ok: true });
    expect(setWorkspaceRoot).toHaveBeenCalledWith(42, null);
  });

  // codex 复审 loop R7:不可信 frame 不得改写窗口 cwd 回退映射(否则 MCP/terminal agent
  // 未显式传 cwd 时会 fallback 到被污染目录,读写/安装/git 落错 workspace)。同文件 CREATE
  // 及 terminal/layout/plugin-mcp IPC 都校验 senderFrame,本 handler 原先漏了 → 补齐。
  it('R7: untrusted senderFrame → DENIED 且不写入 workspaceRoot', () => {
    const before = getWorkspaceRoot(42);
    const result = notify({ root: '/abs-evil' }, { url: 'https://evil.example/' });

    expect(result).toMatchObject({ ok: false, code: IPC_ERR.DENIED });
    expect(setWorkspaceRoot).not.toHaveBeenCalled();
    expect(getWorkspaceRoot(42)).toBe(before);
  });

  it('R7b: 缺失 senderFrame(null / 无 url)同样 DENIED,fail-closed', () => {
    expect(notify({ root: '/abs' }, null)).toMatchObject({
      ok: false,
      code: IPC_ERR.DENIED,
    });
    // frame 对象存在但无 url 也判不可信
    expect(notify({ root: '/abs' }, {})).toMatchObject({
      ok: false,
      code: IPC_ERR.DENIED,
    });
    expect(setWorkspaceRoot).not.toHaveBeenCalled();
  });

  it("T16: browser window 'closed' clears the window root", () => {
    let closed: Listener | null = null;
    const win = {
      id: 42,
      on: vi.fn((event: string, listener: Listener) => {
        if (event === 'closed') closed = listener;
      }),
    };

    browserWindowCreatedListener()({}, win);
    expect(closed).toEqual(expect.any(Function));
    (closed as unknown as Listener)();

    expect(win.on).toHaveBeenCalledWith('closed', expect.any(Function));
    expect(clearWindow).toHaveBeenCalledWith(42);
  });

  it('T16b: a reused window id can be rebuilt after closed cleanup', () => {
    let closed: Listener | null = null;
    const win = {
      id: 42,
      on: vi.fn((event: string, listener: Listener) => {
        if (event === 'closed') closed = listener;
      }),
    };
    setWorkspaceRoot(42, '/old');

    browserWindowCreatedListener()({}, win);
    expect(closed).toEqual(expect.any(Function));
    (closed as unknown as Listener)();
    setWorkspaceRoot(42, '/new');

    expect(getWorkspaceRoot(42)).toBe('/new');
  });
});
