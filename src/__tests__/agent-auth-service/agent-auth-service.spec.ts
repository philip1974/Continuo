// topic-14 agent-auth-service: reverse IPC auth + revoke BDD pin.
// BDD-only: do not modify source files or extract shared test helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  requestAgentAuth,
  resolveAgentAuthRequest,
  revokeAndKillAgentSessions,
  setMcpHostRef,
  MAX_PENDING_AUTH_GLOBAL_FOR_TEST,
  MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST,
} from '../../../electron/main/services/agent-auth.service';
import {
  AGENT_AUTH_CHANNELS,
  type AgentAuthDecision,
  type AgentAuthRequestPayload,
} from '../../../electron/shared/agent-auth-channels';
import type { McpHost } from '../../../electron/main/services/mcp-host.service';
import type { MainTerminalSession } from '../../../electron/main/services/terminal-sessions.service';

type FakeWindow = {
  id: number;
  isDestroyed: () => boolean;
  webContents: {
    send: ReturnType<typeof vi.fn>;
    getURL: () => string;
  };
};

const electronMock = vi.hoisted(() => ({
  windows: [] as FakeWindow[],
}));

const sessionStore = vi.hoisted(() => ({
  list: [] as MainTerminalSession[],
}));

const terminalSessionsMock = vi.hoisted(() => ({
  getAll: vi.fn(() => [...sessionStore.list]),
  remove: vi.fn((id: string) => {
    const index = sessionStore.list.findIndex((s) => s.id === id);
    if (index >= 0) sessionStore.list.splice(index, 1);
  }),
}));

const terminalServiceMock = vi.hoisted(() => ({
  has: vi.fn(),
  kill: vi.fn(),
  forceKill: vi.fn(),
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
  getAll: terminalSessionsMock.getAll,
  remove: terminalSessionsMock.remove,
}));

vi.mock('../../../electron/main/services/terminal.service', () => ({
  has: terminalServiceMock.has,
  kill: terminalServiceMock.kill,
  forceKill: terminalServiceMock.forceKill,
}));

function makeSession(
  partial: Partial<MainTerminalSession> = {},
): MainTerminalSession {
  return {
    id: 'term-1',
    title: 'Terminal 1',
    cwd: '/tmp',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 42,
    ...partial,
  };
}

function makeMcpHost(overrides: Partial<McpHost> = {}): McpHost {
  return {
    port: 19700,
    url: 'http://127.0.0.1:19700',
    tools: new Map(),
    serverInfo: {
      name: 'continuo-test',
      version: '0.0.0',
      protocolVersion: '2024-11-05',
    },
    issueWindowToken: vi.fn(() => 'token'),
    revokeToken: vi.fn(),
    revokeWindowTokens: vi.fn(),
    resolveWindowId: vi.fn(() => null),
    verifyAndResolveCtx: vi.fn(() => null),
    registerTool: vi.fn(),
    removeTool: vi.fn(),
    broadcast: vi.fn(),
    rotateToken: vi.fn(),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeWin(
  id: number,
  opts: { popout?: boolean; destroyed?: boolean } = {},
): FakeWindow {
  return {
    id,
    isDestroyed: () => opts.destroyed === true,
    webContents: {
      send: vi.fn(),
      getURL: () =>
        opts.popout
          ? 'file:///renderer/index.html?popout=1'
          : 'file:///renderer/index.html',
    },
  };
}

function firstAuthPayload(win: FakeWindow): AgentAuthRequestPayload {
  const call = win.webContents.send.mock.calls[0];
  if (!call) throw new Error('missing auth request send');
  return call[1] as AgentAuthRequestPayload;
}

beforeEach(() => {
  vi.useFakeTimers();
  electronMock.windows = [];
  sessionStore.list = [];
  _resetPendingForTest();
  setMcpHostRef(null);
  vi.clearAllMocks();
  terminalServiceMock.has.mockReset();
});

afterEach(() => {
  _resetPendingForTest();
  setMcpHostRef(null);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('agent-auth-service: requestAgentAuth', () => {
  it('T1: sends auth request to the main window and resolves with renderer decision', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];

    const pending = requestAgentAuth({
      method: 'terminal.create_session',
      agentLabel: 'codex',
    });
    const [channel, payload] = win.webContents.send.mock.calls[0]!;
    expect(channel).toBe(AGENT_AUTH_CHANNELS.REQUEST);
    expect(payload).toEqual(
      expect.objectContaining({
        method: 'terminal.create_session',
        agentLabel: 'codex',
        requestId: expect.stringMatching(/^req-/),
      }),
    );

    resolveAgentAuthRequest(
      (payload as AgentAuthRequestPayload).requestId,
      'session',
    );
    await expect(pending).resolves.toBe('session');
  });

  it("T2: no window returns 'denied' immediately", async () => {
    await expect(
      requestAgentAuth({ method: 'terminal.create_session' }),
    ).resolves.toBe('denied');
  });

  it("T2b: all destroyed windows return 'denied'", async () => {
    const destroyed = makeWin(1, { destroyed: true });
    electronMock.windows = [destroyed];

    await expect(
      requestAgentAuth({ method: 'terminal.create_session' }),
    ).resolves.toBe('denied');
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("T2c(R62): webContents.send throwing returns 'denied' immediately without leaking pending", async () => {
    // 竞态:win 通过 isDestroyed 检查,但 send 时 webContents 已销毁 → 同步抛。
    const win = makeWin(1);
    win.webContents.send.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    electronMock.windows = [win];

    // 不抛(契约:失败返 'denied' 而非 reject),且立即结算,不等 5min 超时。
    await expect(
      requestAgentAuth({ method: 'terminal.create_session' }),
    ).resolves.toBe('denied');

    // pending 已清:推进 5min 不应再有任何"延迟超时结算"留痕(_resetPendingForTest 无可清项)。
    const cleared = (() => {
      // 若 pending 残留,_resetPendingForTest 会 settle 它;这里通过再发一个正常请求并确认
      // requestId 不冲突、能独立结算来间接验证 map 干净。
      const ok = makeWin(2);
      electronMock.windows = [ok];
      const p = requestAgentAuth({ method: 'terminal.write' });
      const payload = firstAuthPayload(ok);
      resolveAgentAuthRequest(payload.requestId, 'session');
      return p;
    })();
    await expect(cleared).resolves.toBe('session');
  });

  it("T3: unanswered requests time out after five minutes as 'denied'", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];

    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(pending).resolves.toBe('denied');
  });

  it('T4: prefers a normal window over a popout window', async () => {
    const popout = makeWin(1, { popout: true });
    const normal = makeWin(2);
    electronMock.windows = [popout, normal];

    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(normal);
    resolveAgentAuthRequest(payload.requestId, 'session');

    expect(popout.webContents.send).not.toHaveBeenCalled();
    expect(normal.webContents.send).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe('session');
  });

  it('T4b: all-popout windows fall back to the first live popout', async () => {
    const popout1 = makeWin(1, { popout: true });
    const popout2 = makeWin(2, { popout: true });
    electronMock.windows = [popout1, popout2];

    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(popout1);
    resolveAgentAuthRequest(payload.requestId, 'once');

    expect(popout1.webContents.send).toHaveBeenCalledTimes(1);
    expect(popout2.webContents.send).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe('once');
  });

  it('T5: skips destroyed windows when choosing the main window', async () => {
    const destroyed = makeWin(1, { destroyed: true });
    const normal = makeWin(2);
    electronMock.windows = [destroyed, normal];

    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(normal);
    resolveAgentAuthRequest(payload.requestId, 'session');

    expect(destroyed.webContents.send).not.toHaveBeenCalled();
    expect(normal.webContents.send).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe('session');
  });

  it('T-routing-1: ownerWindowId routes to an alive non-popout window', async () => {
    const fallback = makeWin(1);
    const owner = makeWin(9);
    electronMock.windows = [fallback, owner];

    const pending = requestAgentAuth({
      method: 'terminal.create_session',
      ownerWindowId: 9,
    });
    const payload = firstAuthPayload(owner);
    resolveAgentAuthRequest(payload.requestId, 'session');

    expect(owner.webContents.send).toHaveBeenCalledTimes(1);
    expect(fallback.webContents.send).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe('session');
  });

  it('T-routing-2: missing or destroyed ownerWindowId falls back to pickMainWindow', async () => {
    const fallbackForMissing = makeWin(1);
    electronMock.windows = [fallbackForMissing];

    const missingPending = requestAgentAuth({
      method: 'terminal.create_session',
      ownerWindowId: 99,
    });
    const missingPayload = firstAuthPayload(fallbackForMissing);
    resolveAgentAuthRequest(missingPayload.requestId, 'once');

    expect(fallbackForMissing.webContents.send).toHaveBeenCalledTimes(1);
    await expect(missingPending).resolves.toBe('once');

    const destroyedOwner = makeWin(9, { destroyed: true });
    const fallbackForDestroyed = makeWin(2);
    electronMock.windows = [destroyedOwner, fallbackForDestroyed];

    const destroyedPending = requestAgentAuth({
      method: 'terminal.create_session',
      ownerWindowId: 9,
    });
    const destroyedPayload = firstAuthPayload(fallbackForDestroyed);
    resolveAgentAuthRequest(destroyedPayload.requestId, 'session');

    expect(destroyedOwner.webContents.send).not.toHaveBeenCalled();
    expect(fallbackForDestroyed.webContents.send).toHaveBeenCalledTimes(1);
    await expect(destroyedPending).resolves.toBe('session');
  });

  it("T-routing-3: popout ownerWindowId falls back to pickMainWindow", async () => {
    const popoutOwner = makeWin(9, { popout: true });
    const fallback = makeWin(1);
    electronMock.windows = [popoutOwner, fallback];

    const pending = requestAgentAuth({
      method: 'terminal.create_session',
      ownerWindowId: 9,
    });
    const payload = firstAuthPayload(fallback);
    resolveAgentAuthRequest(payload.requestId, 'session');

    expect(popoutOwner.webContents.send).not.toHaveBeenCalled();
    expect(fallback.webContents.send).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe('session');
  });

  // 边界(E229,E227/E228 pending 数量上限族):未决授权 pending 数量双闸。
  it("E229-1: 单窗口未决授权到 per-window 上限后,再请求立即终态 'denied',不入 pending、不发 IPC", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const max = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    // 凑满 per-window 未决
    const ps: Promise<AgentAuthDecision>[] = [];
    for (let i = 0; i < max; i++) {
      ps.push(requestAgentAuth({ method: 'terminal.create_session' }));
    }
    expect(win.webContents.send).toHaveBeenCalledTimes(max);
    // 第 max+1 个:立即 denied,不发 IPC
    await expect(
      requestAgentAuth({ method: 'terminal.create_session' }),
    ).resolves.toBe('denied');
    expect(win.webContents.send).toHaveBeenCalledTimes(max); // 没多发
    // 清理:全部超时结算,避免悬挂 timer
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await Promise.all(ps);
  });

  it("E229-2: 终态(resolve)释放槽位后,可再接受新授权请求(计数无漂移)", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const max = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    const ps: Promise<AgentAuthDecision>[] = [];
    for (let i = 0; i < max; i++) {
      ps.push(requestAgentAuth({ method: 'terminal.create_session' }));
    }
    // 满了 → 溢出
    await expect(
      requestAgentAuth({ method: 'terminal.create_session' }),
    ).resolves.toBe('denied');
    // resolve 第一个,释放一个槽位
    const firstPayload = firstAuthPayload(win);
    resolveAgentAuthRequest(firstPayload.requestId, 'session');
    await expect(ps[0]!).resolves.toBe('session');
    // 现在能再接受一个:正常发 IPC
    const sendsBefore = win.webContents.send.mock.calls.length;
    const revived = requestAgentAuth({ method: 'terminal.write' });
    expect(win.webContents.send).toHaveBeenCalledTimes(sendsBefore + 1);
    // 清理
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await Promise.all([...ps.slice(1), revived]);
  });

  it("E229-3: per-window 是 per-window 的:win1 满了,win2 仍可请求", async () => {
    const win1 = makeWin(1);
    const win2 = makeWin(2);
    electronMock.windows = [win1, win2];
    const max = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    const ps: Promise<AgentAuthDecision>[] = [];
    for (let i = 0; i < max; i++) {
      // 显式路由到 win1
      ps.push(
        requestAgentAuth({
          method: 'terminal.create_session',
          ownerWindowId: 1,
        }),
      );
    }
    // win1 溢出
    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }),
    ).resolves.toBe('denied');
    // win2 不受影响
    const onWin2 = requestAgentAuth({
      method: 'terminal.write',
      ownerWindowId: 2,
    });
    expect(win2.webContents.send).toHaveBeenCalledTimes(1);
    const p2 = firstAuthPayload(win2);
    resolveAgentAuthRequest(p2.requestId, 'session');
    await expect(onWin2).resolves.toBe('session');
    // 清理
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await Promise.all(ps);
  });

  it("E229-4: 全局上限:跨多窗累计到全局上限后,新窗口请求也被全局闸拒", async () => {
    const perWin = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    const global = MAX_PENDING_AUTH_GLOBAL_FOR_TEST;
    const winCount = Math.ceil(global / perWin);
    const wins = Array.from({ length: winCount + 1 }, (_, i) => makeWin(i + 1));
    electronMock.windows = wins;
    const ps: Promise<AgentAuthDecision>[] = [];
    let filled = 0;
    let wi = 0;
    while (filled < global) {
      const id = wins[wi]!.id;
      // 每窗填到 per-window 上限或补满全局剩余
      const room = Math.min(perWin, global - filled);
      for (let i = 0; i < room; i++) {
        ps.push(requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: id }));
        filled += 1;
      }
      wi += 1;
    }
    // 全局已满 → 全新窗口(per-window 计数为 0)也被全局闸拒
    const freshId = wins[winCount]!.id;
    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: freshId }),
    ).resolves.toBe('denied');
    expect(wins[winCount]!.webContents.send).not.toHaveBeenCalled();
    // 清理
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await Promise.all(ps);
  });
});

describe('agent-auth-service: pending lifecycle', () => {
  it("T6: resolveAgentAuthRequest resolves a pending request as 'once'", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(win);

    resolveAgentAuthRequest(payload.requestId, 'once');

    await expect(pending).resolves.toBe('once');
  });

  it('T7: resolving an unknown request id is a no-op', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(win);

    expect(() =>
      resolveAgentAuthRequest('non-existent', 'session'),
    ).not.toThrow();
    resolveAgentAuthRequest(payload.requestId, 'session');

    await expect(pending).resolves.toBe('session');
  });

  it('T8: resolving the same request twice only uses the first decision', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(win);

    resolveAgentAuthRequest(payload.requestId, 'session');
    resolveAgentAuthRequest(payload.requestId, 'denied');

    await expect(pending).resolves.toBe('session');
  });

  it('T9: resolving a request clears the timeout path', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    let settled: AgentAuthDecision | null = null;
    const pending = requestAgentAuth({ method: 'terminal.create_session' }).then(
      (decision) => {
        settled = decision;
        return decision;
      },
    );
    const payload = firstAuthPayload(win);

    resolveAgentAuthRequest(payload.requestId, 'once');
    await expect(pending).resolves.toBe('once');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(settled).toBe('once');
  });

  it("T10: _resetPendingForTest denies all pending requests", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const first = requestAgentAuth({ method: 'terminal.create_session' });
    const second = requestAgentAuth({ method: 'terminal.write' });

    _resetPendingForTest();

    await expect(first).resolves.toBe('denied');
    await expect(second).resolves.toBe('denied');
  });
});

describe('agent-auth-service: revokeAndKillAgentSessions', () => {
  // race(R91,安全):撤销须同步结算所有 pending 授权请求为 denied + 清空。否则撤销前卡在授权
  // 等待的请求收到迟到 respond('session') 仍被放行 → 撤销后那次 tool call 仍执行一次。
  it('R91: revoke 把 in-flight 授权请求结算为 denied,迟到 respond 不再放行', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pendingAuth = requestAgentAuth({ method: 'terminal.create_session' });
    const payload = firstAuthPayload(win);

    // 撤销:应立即把这条 in-flight 请求 deny + 清 pending。
    revokeAndKillAgentSessions();
    await expect(pendingAuth).resolves.toBe('denied');

    // 撤销后到达的迟到 respond('session') → 找不到 pending → no-op,不能复活已撤销的授权。
    expect(() =>
      resolveAgentAuthRequest(payload.requestId, 'session'),
    ).not.toThrow();
    // pendingAuth 仍是 denied(未被迟到 session 覆盖)。
    await expect(pendingAuth).resolves.toBe('denied');
  });

  it('T11: rotates token and force-kills only agent sessions', () => {
    // 撤销是安全动作:用 forceKill(立即 SIGKILL)而非 kill(3s grace)。
    const rotateToken = vi.fn();
    setMcpHostRef(makeMcpHost({ rotateToken }));
    terminalServiceMock.has.mockReturnValue(true);
    sessionStore.list = [
      makeSession({ id: 'a', originHint: 'agent' }),
      makeSession({ id: 'b', originHint: 'user' }),
      makeSession({ id: 'c', originHint: 'agent' }),
    ];

    const result = revokeAndKillAgentSessions();

    expect(result).toEqual({ killed: 2, rotated: true });
    expect(rotateToken).toHaveBeenCalledTimes(1);
    expect(terminalServiceMock.forceKill).toHaveBeenCalledWith('a');
    expect(terminalServiceMock.forceKill).toHaveBeenCalledWith('c');
    expect(terminalServiceMock.forceKill).not.toHaveBeenCalledWith('b');
    // 不走软杀 kill(),避免撤销后子进程还有 3s grace 继续运行
    expect(terminalServiceMock.kill).not.toHaveBeenCalled();
    expect(terminalSessionsMock.remove).toHaveBeenCalledWith('a');
    expect(terminalSessionsMock.remove).toHaveBeenCalledWith('c');
    expect(terminalSessionsMock.remove).not.toHaveBeenCalledWith('b');
  });

  it('T12: snapshots sessions before removal so backing array mutation is safe', () => {
    terminalServiceMock.has.mockReturnValue(true);
    sessionStore.list = [
      makeSession({ id: 'a', originHint: 'agent' }),
      makeSession({ id: 'b', originHint: 'agent' }),
    ];

    const result = revokeAndKillAgentSessions();

    expect(result).toEqual({ killed: 2, rotated: false });
    expect(terminalSessionsMock.remove).toHaveBeenCalledWith('a');
    expect(terminalSessionsMock.remove).toHaveBeenCalledWith('b');
    expect(terminalServiceMock.forceKill).toHaveBeenCalledWith('a');
    expect(terminalServiceMock.forceKill).toHaveBeenCalledWith('b');
    expect(sessionStore.list).toEqual([]);
  });

  it('revoke 直接遍历 terminalSessions.getAll 快照,不再 Array.from 二次复制', () => {
    terminalServiceMock.has.mockReturnValue(false);
    sessionStore.list = [
      makeSession({ id: 'a', originHint: 'agent' }),
      makeSession({ id: 'b', originHint: 'user' }),
    ];
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      const result = revokeAndKillAgentSessions();

      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ killed: 1, rotated: false });
      expect(terminalSessionsMock.remove).toHaveBeenCalledWith('a');
      expect(terminalSessionsMock.remove).not.toHaveBeenCalledWith('b');
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('T13: null mcpHostRef still removes and kills agent sessions without rotating', () => {
    setMcpHostRef(null);
    terminalServiceMock.has.mockReturnValue(true);
    sessionStore.list = [makeSession({ id: 'a', originHint: 'agent' })];

    const result = revokeAndKillAgentSessions();

    expect(result).toEqual({ killed: 1, rotated: false });
    expect(terminalSessionsMock.remove).toHaveBeenCalledWith('a');
    expect(terminalServiceMock.forceKill).toHaveBeenCalledWith('a');
  });

  it('T13b: has=false skips PTY kill but still removes metadata', () => {
    const rotateToken = vi.fn();
    setMcpHostRef(makeMcpHost({ rotateToken }));
    terminalServiceMock.has.mockReturnValue(false);
    sessionStore.list = [makeSession({ id: 'a', originHint: 'agent' })];

    const result = revokeAndKillAgentSessions();

    expect(result).toEqual({ killed: 1, rotated: true });
    expect(rotateToken).toHaveBeenCalledTimes(1);
    expect(terminalSessionsMock.remove).toHaveBeenCalledWith('a');
    expect(terminalServiceMock.forceKill).not.toHaveBeenCalled();
  });
});
