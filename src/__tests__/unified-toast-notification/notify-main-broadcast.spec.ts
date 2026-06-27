// topic-15 unified-toast-notification: main pushNotification broadcast, targeted send, and log contracts. BDD 先行,源实现 Op3-Op11 落地后才会通过。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTIFY_CHANNELS } from '../../../electron/shared/notify-channels';
import { pushNotification } from '../../../electron/main/ipc/notify.ipc';

const electronMock = vi.hoisted(() => ({
  windows: [] as Array<{
    id: number;
    isDestroyed: ReturnType<typeof vi.fn>;
    webContents: { send: ReturnType<typeof vi.fn> };
  }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => electronMock.windows),
    fromId: vi.fn((id: number) => electronMock.windows.find((w) => w.id === id) ?? null),
  },
}));

function win(id: number, destroyed = false) {
  return {
    id,
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  };
}

beforeEach(() => {
  electronMock.windows = [win(1), win(2), win(3, true)];
  vi.restoreAllMocks();
});

describe('unified-toast-notification: main pushNotification', () => {
  it('T7 broadcasts to all non-destroyed BrowserWindows when windowId is omitted', () => {
    pushNotification({ level: 'info', message: 'hello', code: 'HELLO' });

    expect(electronMock.windows[0]!.webContents.send).toHaveBeenCalledWith(
      NOTIFY_CHANNELS.PUSH,
      { level: 'info', message: 'hello', code: 'HELLO' },
    );
    expect(electronMock.windows[1]!.webContents.send).toHaveBeenCalledTimes(1);
    expect(electronMock.windows[2]!.webContents.send).not.toHaveBeenCalled();
  });

  it('T7b logs once inside helper before sending', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    pushNotification({ level: 'error', message: 'boom', code: 'BOOM' });
    pushNotification({ level: 'warning', message: 'careful', code: 'WARN' });
    pushNotification({ level: 'info', message: 'note', code: 'INFO' });
    pushNotification({ level: 'success', message: 'done', code: 'OK' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[notify-push]');
  });

  // race(R70,R62-R68 同族):isDestroyed() 检查后窗口销毁致 send 抛。pushNotification 常被失败
  // 处理路径当兜底反馈,定向 send 抛会遮蔽原业务错误;广播 send 抛会中断后续窗口。每次 send 独立
  // try/catch。
  it('R70 定向 send 抛错 → pushNotification 不抛(不遮蔽原业务错误)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = win(2);
    target.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    electronMock.windows = [win(1), target];

    expect(() =>
      pushNotification({ level: 'error', message: 'x', code: 'X', windowId: 2 }),
    ).not.toThrow();
  });

  it('R70 广播首窗 send 抛错 → 不抛 + 后续窗口仍收到', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dead = win(1);
    dead.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    const healthy = win(2);
    electronMock.windows = [dead, healthy];

    expect(() =>
      pushNotification({ level: 'info', message: 'm', code: 'M' }),
    ).not.toThrow();
    expect(healthy.webContents.send).toHaveBeenCalledWith(NOTIFY_CHANNELS.PUSH, {
      level: 'info',
      message: 'm',
      code: 'M',
    });
  });

  it('T8 sends only to BrowserWindow.fromId(windowId) when windowId is provided', () => {
    pushNotification({
      level: 'error',
      message: 'targeted',
      code: 'TARGET',
      windowId: 2,
    });

    expect(electronMock.windows[0]!.webContents.send).not.toHaveBeenCalled();
    expect(electronMock.windows[1]!.webContents.send).toHaveBeenCalledWith(
      NOTIFY_CHANNELS.PUSH,
      {
        level: 'error',
        message: 'targeted',
        code: 'TARGET',
        windowId: 2,
      },
    );
    expect(electronMock.windows[2]!.webContents.send).not.toHaveBeenCalled();
  });
});
