// race(R68,R63-R67 同族):terminal.ipc 的 broadcastSessionsChanged(terminalSessions subscriber)
// 遍历窗口裸 w.webContents.send(SESSIONS_CHANGED, owner 过滤快照)。窗口在 isDestroyed() 检查后
// 销毁 → send 抛 "Object has been destroyed" → 中断窗口循环,坏窗口之后的窗口漏收 session 快照,
// Dock/Terminal 面板停在旧 session 列表。修复:每个窗口 send 独立 try/catch。

import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeWin = {
  id: number;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
};

const mocks = vi.hoisted(() => ({ windows: [] as FakeWin[] }));

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// broadcastSessionsChanged 读 terminalSessions.getAll(ownerWindowId);mock 返回按 owner 区分的快照。
vi.mock('../../../electron/main/services/terminal-sessions.service', () => ({
  getAll: vi.fn((opts?: { ownerWindowId?: number }) => [
    { id: `sess-for-${opts?.ownerWindowId}` },
  ]),
  subscribe: vi.fn(() => () => undefined),
}));

function makeWin(id: number, opts: { throwOnSend?: boolean } = {}): FakeWin {
  const send = vi.fn(() => {
    if (opts.throwOnSend) throw new Error('Object has been destroyed');
  });
  return { id, isDestroyed: () => false, webContents: { send } };
}

afterEach(() => {
  mocks.windows = [];
  vi.clearAllMocks();
});

describe('race(R68) · terminal broadcastSessionsChanged 单窗口 send 抛错不中断', () => {
  it('第一个窗口 send 抛错 → 不抛 + 其后窗口仍收到 owner 过滤的 SESSIONS_CHANGED', async () => {
    const dead = makeWin(11, { throwOnSend: true });
    const healthy = makeWin(22);
    mocks.windows = [dead, healthy];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { broadcastSessionsChanged } = await import(
      '../../../electron/main/ipc/terminal.ipc'
    );
    const { TERMINAL_CHANNELS } = await import(
      '../../../electron/shared/terminal-channels'
    );

    expect(() => broadcastSessionsChanged()).not.toThrow();
    // 抛错窗口之后的健康窗口仍收到按其 ownerWindowId 过滤的快照(循环未中断)。
    expect(healthy.webContents.send).toHaveBeenCalledWith(
      TERMINAL_CHANNELS.SESSIONS_CHANGED,
      [{ id: 'sess-for-22' }],
    );
  });
});
