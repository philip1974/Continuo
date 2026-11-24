import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { sendToWindow } from '../lib/broadcast';

type FakeWin = Parameters<typeof sendToWindow>[0];

function fakeWin(opts: { destroyed?: boolean; sendThrows?: boolean } = {}) {
  const send = vi.fn(() => {
    if (opts.sendThrows) throw new Error('Object has been destroyed');
  });
  return { win: { isDestroyed: () => !!opts.destroyed, webContents: { send } } as unknown as FakeWin, send };
}

afterEach(() => vi.restoreAllMocks());

describe('sendToWindow', () => {
  it('存活窗口 → send(channel, payload)', () => {
    const { win, send } = fakeWin();
    sendToWindow(win, 'ch', { a: 1 }, '[t]');
    expect(send).toHaveBeenCalledWith('ch', { a: 1 });
  });

  it('null / 已销毁 → 不 send', () => {
    const { win, send } = fakeWin({ destroyed: true });
    sendToWindow(win, 'ch', 1, '[t]');
    sendToWindow(null, 'ch', 1, '[t]');
    expect(send).not.toHaveBeenCalled();
  });

  it('send 抛错 → 只记录,不冒泡', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { win } = fakeWin({ sendThrows: true });
    expect(() => sendToWindow(win, 'ch', 1, '[t]')).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith('[t] send failed', expect.any(Error));
  });
});
