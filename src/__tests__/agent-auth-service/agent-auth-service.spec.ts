// topic-14 agent-auth-service: reverse IPC auth + revoke BDD pin.
// BDD-only: do not modify source files or extract shared test helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  requestAgentAuth,
  resolveAgentAuthRequest,
  revokeAndKillAgentSessions,
  setMcpHostRef,
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
  getAll: vi.fn(() => sessionStore.list),
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
