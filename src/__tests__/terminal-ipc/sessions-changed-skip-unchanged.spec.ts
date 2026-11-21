// perf:sessions_changed 此前任一会话变化都对**每个**窗口 getAll + toRendererSessions + send,
// 无关窗口(自己的会话没变)也反复收到内容相同的快照并在 renderer 重跑过滤 / reconcile。
// 现按窗口记录上次发出的 owner 过滤结果(会话对象不可变、变化即整体替换),长度与每个元素引用都相同
// 则跳过该窗口;没有记录(新窗口 / 已 forget)一定发送;窗口关闭与 renderer 重新拉取
// list_sessions(初始化 / reload)时清记录,保证首个权威快照仍能到达。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_CHANNELS } from '../../../electron/shared/terminal-channels';
import {
  broadcastSessionsChanged,
  forgetSessionsBroadcastWindow,
  registerTerminalIpc,
} from '../../../electron/main/ipc/terminal.ipc';
import * as terminalSessions from '../../../electron/main/services/terminal-sessions.service';

type IpcHandler = (event: unknown, raw: unknown) => Promise<unknown>;
type FakeWin = {
  id: number;
  destroyed: boolean;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
};

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  senderToWindow: new Map<object, unknown>(),
  windows: [] as FakeWin[],
}));

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: {
    fromWebContents: vi.fn((sender: object) => electronMock.senderToWindow.get(sender) ?? null),
    getAllWindows: vi.fn(() => electronMock.windows),
    fromId: vi.fn((id: number) => electronMock.windows.find((w) => w.id === id) ?? null),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
}));

function makeWin(id: number): FakeWin {
  const w: FakeWin = {
    id,
    destroyed: false,
    isDestroyed: () => w.destroyed,
    once: vi.fn(),
    webContents: { send: vi.fn() },
  };
  return w;
}

function sessionsSends(w: FakeWin): unknown[] {
  return w.webContents.send.mock.calls
    .filter((c) => c[0] === TERMINAL_CHANNELS.SESSIONS_CHANGED)
    .map((c) => c[1]);
}

function addSession(id: string, ownerWindowId: number): void {
  terminalSessions.add({ id, title: id, cwd: `/${id}`, originHint: 'user', ownerWindowId });
}

let winA: FakeWin;
let winB: FakeWin;
let senderA: object;

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.senderToWindow.clear();
  terminalSessions._reset();
  // 已发送记录是模块级状态,用例间复用同一窗口 id → 先清掉
  forgetSessionsBroadcastWindow(10);
  forgetSessionsBroadcastWindow(20);
  winA = makeWin(10);
  winB = makeWin(20);
  senderA = {};
  electronMock.windows = [winA, winB];
  electronMock.senderToWindow.set(senderA, winA);
  registerTerminalIpc();
});

describe('sessions_changed 跳过内容未变的窗口', () => {
  it('首次广播对没有记录的窗口一定发送(含空快照)', () => {
    addSession('a1', 10);
    expect(sessionsSends(winA)).toHaveLength(1);
    expect(sessionsSends(winB)).toEqual([[]]);
  });

  it('只影响窗口 A 的会话变化:A 照常收到,B 不再收到内容相同的快照', () => {
    addSession('a1', 10);
    addSession('a2', 10);
    terminalSessions.updateCwd('a1', '/elsewhere');
    terminalSessions.setExited('a2', 0);
    terminalSessions.remove('a2');

    expect(sessionsSends(winA)).toHaveLength(5);
    expect(sessionsSends(winA).at(-1)).toEqual([
      expect.objectContaining({ id: 'a1', cwd: '/elsewhere' }),
    ]);
    expect(sessionsSends(winB)).toHaveLength(1); // 只有首次(无记录)那一次
  });

  it('B 自己的会话变化 → B 收到新快照', () => {
    addSession('a1', 10);
    addSession('b1', 20);
    expect(sessionsSends(winB)).toHaveLength(2);
    expect(sessionsSends(winB).at(-1)).toEqual([expect.objectContaining({ id: 'b1' })]);
    expect(sessionsSends(winA)).toHaveLength(1);
  });

  it('renderer 拉取 list_sessions(初始化 / reload)后清记录 → 下一次广播即使内容未变也发送', async () => {
    addSession('a1', 10);
    const handler = electronMock.handlers.get(TERMINAL_CHANNELS.LIST_SESSIONS)!;
    await expect(
      handler({ sender: senderA, senderFrame: { url: 'file:///renderer/index.html' } }, {}),
    ).resolves.toMatchObject({ ok: true });

    addSession('b1', 20); // A 的会话没变
    expect(sessionsSends(winA)).toHaveLength(2);
  });

  it('窗口 closed 时清除其记录', () => {
    addSession('a1', 10); // B 记录为 []
    expect(sessionsSends(winB)).toEqual([[]]);
    const closedCb = winB.once.mock.calls.find((c) => c[0] === 'closed')?.[1] as () => void;
    expect(closedCb).toBeTypeOf('function');
    winB.destroyed = true;
    closedCb();

    // 记录已清:同 id 的窗口(测试模拟)再次广播时,内容未变([])也会重新发送。
    winB.destroyed = false;
    broadcastSessionsChanged();
    expect(sessionsSends(winB)).toEqual([[], []]);
  });
});
