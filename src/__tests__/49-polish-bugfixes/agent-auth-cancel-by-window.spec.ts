// topic 49 第十七轮 · P2-AT:目标窗口关闭立即结算 agent-auth pending 为 denied。
//
// 根因:requestAgentAuth 把决定权绑在某 webContents(target 或 pickMainWindow 兜底),
// 但 pending 的取消路径只有 5min 定时器。窗口 closed/destroyed 不会提前结算属于它的
// pending。发起调用的是**仍存活的外部 agent CLI 进程**,用户关窗后它要干等满 5min 才
// 收到默认 denied,表现为 agent 假死。这与 request-scope「等待者是已死请求方自己」不同。
// 修复:pending 记目标 windowId,win.on('closed') 调 cancelAgentAuthByWindow 立即结算
// denied(镜像 stop-hook broker.cancelByWindow,审计 #3)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  cancelAgentAuthByWindow,
  requestAgentAuth,
} from '../../../electron/main/services/agent-auth.service';
import type { AgentAuthRequestPayload } from '../../../electron/shared/agent-auth-channels';

const electronMock = vi.hoisted(() => ({
  windows: [] as Array<{
    id: number;
    isDestroyed: () => boolean;
    webContents: { send: ReturnType<typeof vi.fn>; getURL: () => string };
  }>,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => electronMock.windows),
    fromId: vi.fn(
      (id: number) => electronMock.windows.find((w) => w.id === id) ?? null,
    ),
  },
}));
vi.mock('../../../electron/main/services/terminal-sessions.service', () => ({
  getAll: vi.fn(() => []),
  remove: vi.fn(),
}));
vi.mock('../../../electron/main/services/terminal.service', () => ({
  has: vi.fn(),
  kill: vi.fn(),
  forceKill: vi.fn(),
}));

function makeWin(id: number) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
      getURL: () => 'file:///renderer/index.html',
    },
  };
}

beforeEach(() => {
  electronMock.windows = [];
  _resetPendingForTest();
  vi.clearAllMocks();
});
afterEach(() => {
  _resetPendingForTest();
});

describe('topic49 P2-AT · cancelAgentAuthByWindow', () => {
  it('窗口关闭 → 发往它的 pending 立即结算为 denied(不等 5min)', async () => {
    const win = makeWin(7);
    electronMock.windows = [win];

    const p = requestAgentAuth({
      method: 'terminal.create_session',
      ownerWindowId: 7,
    });
    // 弹窗已推送到窗口 7
    expect(win.webContents.send).toHaveBeenCalledTimes(1);

    const n = cancelAgentAuthByWindow(7);
    expect(n).toBe(1);
    await expect(p).resolves.toBe('denied');
  });

  it('只取消目标窗口的 pending,其它窗口不受影响', async () => {
    const w7 = makeWin(7);
    const w9 = makeWin(9);
    electronMock.windows = [w7, w9];

    const p7 = requestAgentAuth({ method: 'm', ownerWindowId: 7 });
    const p9 = requestAgentAuth({ method: 'm', ownerWindowId: 9 });

    const n = cancelAgentAuthByWindow(7);
    expect(n).toBe(1);
    await expect(p7).resolves.toBe('denied');

    // 窗口 9 的 pending 仍存活,可被正常应答
    const payload9 = w9.webContents.send.mock.calls[0]![1] as AgentAuthRequestPayload;
    const { resolveAgentAuthRequest } = await import(
      '../../../electron/main/services/agent-auth.service'
    );
    resolveAgentAuthRequest(payload9.requestId, 'session');
    await expect(p9).resolves.toBe('session');
  });

  it('无匹配窗口 → 返回 0,不抛', () => {
    expect(cancelAgentAuthByWindow(123)).toBe(0);
  });
});
