// topic-14 agent-auth-service: reverse IPC auth + revoke BDD pin.
// BDD-only: do not modify source files or extract shared test helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPendingForTest,
  answerAgentAuthRequest,
  cancelAllAgentAuth,
  requestAgentAuth,
  resolveAgentAuthRequest,
  revokeAndKillAgentSessions,
  setMcpHostRef,
  MAX_PENDING_AUTH_GLOBAL_FOR_TEST,
  MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST,
} from '../../../electron/main/services/agent-auth.service';
import {
  AGENT_AUTH_CHANNELS,
  AGENT_AUTH_PROMPT_TIMEOUT_MS,
  AGENT_AUTH_QUEUE_MAX_MS,
  type AgentAuthDecision,
  type AgentAuthRequestPayload,
} from '../../../electron/shared/agent-auth-channels';
import { pickMainWindowPreferNonPopout } from '../../../electron/main/services/main-window-picker.service';
import type { McpHost } from '../../../electron/main/services/mcp-host.service';
import type { MainTerminalSession } from '../../../electron/main/services/terminal-sessions.service';
import { trackAgentTerminalCreate } from '../../../electron/main/services/agent-terminal-inflight';

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

/**
 * 让窗口的终端域处于「本次启动期间允许」(之后清掉 send 记录)。此后该域的请求不经授权弹窗节流(同一调用方单飞 /
 * 速率上限,见 src/__tests__/agent-auth-prompt-throttle/)原样转发给 renderer —— 未决数量上限只在这条路径上够得着。
 */
async function grantTerminalSession(win: FakeWindow): Promise<void> {
  const p = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: win.id });
  const payload = win.webContents.send.mock.calls.at(-1)![1] as AgentAuthRequestPayload;
  resolveAgentAuthRequest(payload.requestId, 'session');
  await p;
  win.webContents.send.mockClear();
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
  it('pickMainWindowPreferNonPopout 单趟扫描,不调用 windows.find', () => {
    const destroyed = makeWin(1, { destroyed: true });
    const popout = makeWin(2, { popout: true });
    const normal = makeWin(3);
    const windows = [destroyed, popout, normal];
    const findSpy = vi.spyOn(windows, 'find');

    try {
      expect(pickMainWindowPreferNonPopout(windows)).toBe(normal);
      expect(pickMainWindowPreferNonPopout([destroyed, popout])).toBe(popout);
      expect(pickMainWindowPreferNonPopout([destroyed])).toBeNull();
      expect(findSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
    }
  });

  it('T1: sends auth request to the main window and resolves with renderer decision', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];

    const pending = requestAgentAuth({
      method: 'terminal.create_session',
      ownerWindowId: 1,
    });
    const [channel, payload] = win.webContents.send.mock.calls[0]!;
    expect(channel).toBe(AGENT_AUTH_CHANNELS.REQUEST);
    expect(payload).toEqual(
      expect.objectContaining({
        method: 'terminal.create_session',
        requestId: expect.stringMatching(/^req-/),
      }),
    );

    resolveAgentAuthRequest(
      (payload as AgentAuthRequestPayload).requestId,
      'session',
    );
    await expect(pending).resolves.toBe('session');
  });

  // 安全(F2):外部客户端的授权请求带 external 标记推给 renderer(弹窗标注来源、只用 external 授权状态);
  // 窗口请求不带该字段。
  it('T1b: external=true → payload.external=true;未给 → payload 无 external 字段', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    void requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1, external: true });
    void requestAgentAuth({ method: 'terminal.read_output', ownerWindowId: 1 });
    const [, p1] = win.webContents.send.mock.calls[0]!;
    const [, p2] = win.webContents.send.mock.calls[1]!;
    expect((p1 as AgentAuthRequestPayload).external).toBe(true);
    expect(p2 as object).not.toHaveProperty('external');
  });

  it("T2: no window returns 'denied' immediately", async () => {
    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }),
    ).resolves.toBe('denied');
  });

  it("T2b: all destroyed windows return 'denied'", async () => {
    const destroyed = makeWin(1, { destroyed: true });
    electronMock.windows = [destroyed];

    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }),
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

    // 不抛(契约:失败返 'denied' 而非 reject),且立即结算,不等无应答超时。
    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }),
    ).resolves.toBe('denied');

    // pending 已清:推进超时时长不应再有任何"延迟超时结算"留痕(_resetPendingForTest 无可清项)。
    const cleared = (() => {
      // 若 pending 残留,_resetPendingForTest 会 settle 它;这里通过再发一个正常请求并确认
      // requestId 不冲突、能独立结算来间接验证 map 干净。
      const ok = makeWin(2);
      electronMock.windows = [ok];
      const p = requestAgentAuth({ method: 'terminal.write', ownerWindowId: 2 });
      const payload = firstAuthPayload(ok);
      resolveAgentAuthRequest(payload.requestId, 'session');
      return p;
    })();
    await expect(cleared).resolves.toBe('session');
  });

  it("T3: unanswered requests time out after five minutes as 'denied'", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];

    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_PROMPT_TIMEOUT_MS);

    await expect(pending).resolves.toBe('denied');
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

  // 安全(fail-closed):调用方显式给了 ownerWindowId 但该窗口无效 / 已销毁 / 是 popout 时**拒绝**。此前回落到
  // 第一个主窗口 —— 会话所属窗口已关(或是 popout)时,授权弹到用户正在用的另一个窗口,用户以为是本窗口
  // 的 agent 而放行(或该窗口已 session 授权 → 静默放行)。popout 无可靠的「所属主窗」映射(window.open 子窗,
  // 未设 parent),且 popout 不挂授权弹窗,故一律拒绝。
  it("T-routing-2: unknown or destroyed explicit ownerWindowId → 'denied', no fallback IPC", async () => {
    const other = makeWin(1);
    electronMock.windows = [other];

    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 99 }),
    ).resolves.toBe('denied');
    expect(other.webContents.send).not.toHaveBeenCalled();

    const destroyedOwner = makeWin(9, { destroyed: true });
    const other2 = makeWin(2);
    electronMock.windows = [destroyedOwner, other2];

    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 9 }),
    ).resolves.toBe('denied');
    expect(destroyedOwner.webContents.send).not.toHaveBeenCalled();
    expect(other2.webContents.send).not.toHaveBeenCalled();
  });

  it("T-routing-3: popout explicit ownerWindowId → 'denied', no fallback IPC", async () => {
    const popoutOwner = makeWin(9, { popout: true });
    const other = makeWin(1);
    electronMock.windows = [popoutOwner, other];

    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 9 }),
    ).resolves.toBe('denied');
    expect(popoutOwner.webContents.send).not.toHaveBeenCalled();
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  // 安全(fail-closed):未给 ownerWindowId 一律拒绝,不再回落到第一个主窗。McpCallCtx.ownerWindowId 必填,
  // 该回落是死代码;若将来有无窗口上下文的调用方(如 external 客户端)走到这里,弹到用户正在用的任意窗口
  // 会让用户误以为是本窗口 agent 而放行(或该窗口已 session 授权 → 静默放行)。
  it("T-routing-4: ownerWindowId omitted → 'denied', no IPC to any window", async () => {
    const popout = makeWin(1, { popout: true });
    const normal = makeWin(2);
    electronMock.windows = [popout, normal];

    await expect(
      requestAgentAuth({ method: 'terminal.create_session' }),
    ).resolves.toBe('denied');
    expect(normal.webContents.send).not.toHaveBeenCalled();
    expect(popout.webContents.send).not.toHaveBeenCalled();
  });

  // 边界(E229,E227/E228 pending 数量上限族):未决授权 pending 数量双闸。
  it("E229-1: 单窗口未决授权到 per-window 上限后,再请求立即终态 'denied',不入 pending、不发 IPC", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    await grantTerminalSession(win);
    const max = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    // 凑满 per-window 未决
    const ps: Promise<AgentAuthDecision>[] = [];
    for (let i = 0; i < max; i++) {
      ps.push(requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }));
    }
    expect(win.webContents.send).toHaveBeenCalledTimes(max);
    // 第 max+1 个:立即 denied,不发 IPC
    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }),
    ).resolves.toBe('denied');
    expect(win.webContents.send).toHaveBeenCalledTimes(max); // 没多发
    // 清理:全部结算,避免悬挂 timer(超时从开始显示起算、逐个显示 → 推进到排队兜底上限,其余按取消结算)
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_QUEUE_MAX_MS);
    await Promise.all(ps);
  });

  it("E229-2: 终态(resolve)释放槽位后,可再接受新授权请求(计数无漂移)", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    await grantTerminalSession(win);
    const max = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    const ps: Promise<AgentAuthDecision>[] = [];
    for (let i = 0; i < max; i++) {
      ps.push(requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }));
    }
    // 满了 → 溢出
    await expect(
      requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }),
    ).resolves.toBe('denied');
    // resolve 第一个,释放一个槽位
    const firstPayload = firstAuthPayload(win);
    resolveAgentAuthRequest(firstPayload.requestId, 'session');
    await expect(ps[0]!).resolves.toBe('session');
    // 现在能再接受一个:正常发 IPC
    const sendsBefore = win.webContents.send.mock.calls.length;
    const revived = requestAgentAuth({ method: 'terminal.write', ownerWindowId: 1 });
    expect(win.webContents.send).toHaveBeenCalledTimes(sendsBefore + 1);
    // 清理
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_QUEUE_MAX_MS);
    await Promise.all([...ps.slice(1), revived]);
  });

  it("E229-3: per-window 是 per-window 的:win1 满了,win2 仍可请求", async () => {
    const win1 = makeWin(1);
    const win2 = makeWin(2);
    electronMock.windows = [win1, win2];
    await grantTerminalSession(win1);
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
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_QUEUE_MAX_MS);
    await Promise.all(ps);
  });

  it("E229-4: 全局上限:跨多窗累计到全局上限后,新窗口请求也被全局闸拒", async () => {
    const perWin = MAX_PENDING_AUTH_PER_WINDOW_FOR_TEST;
    const global = MAX_PENDING_AUTH_GLOBAL_FOR_TEST;
    const winCount = Math.ceil(global / perWin);
    const wins = Array.from({ length: winCount + 1 }, (_, i) => makeWin(i + 1));
    electronMock.windows = wins;
    for (const w of wins.slice(0, winCount)) await grantTerminalSession(w);
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
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_QUEUE_MAX_MS);
    await Promise.all(ps);
  });
});

describe('agent-auth-service: pending lifecycle', () => {
  it("T6: resolveAgentAuthRequest resolves a pending request as 'once'", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    const payload = firstAuthPayload(win);

    resolveAgentAuthRequest(payload.requestId, 'once');

    await expect(pending).resolves.toBe('once');
  });

  it('T7: resolving an unknown request id is a no-op', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    const payload = firstAuthPayload(win);

    expect(() =>
      resolveAgentAuthRequest('non-existent', 'session'),
    ).not.toThrow();
    resolveAgentAuthRequest(payload.requestId, 'session');

    await expect(pending).resolves.toBe('session');
  });

  // T7b:renderer 应答入口(ipc respond)对 main 已不存在的 requestId(已撤销 / 超时 / 窗口关闭结算)
  // 须返回失败(抛 AGENT_AUTH_REQUEST_NOT_PENDING),renderer 据此不把「本次启动期间允许」记为生效。
  it('T7b: answerAgentAuthRequest 对已不存在的 request id 抛 AGENT_AUTH_REQUEST_NOT_PENDING', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    const payload = firstAuthPayload(win);

    revokeAndKillAgentSessions(); // 撤销结算并删除 pending
    await expect(pending).resolves.toBe('denied');
    expect(() => answerAgentAuthRequest(payload.requestId, 'session', 1)).toThrow(
      expect.objectContaining({ code: 'AGENT_AUTH_REQUEST_NOT_PENDING' }),
    );
  });

  it('T7c: answerAgentAuthRequest 对仍在等待的 request id 正常结算', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    const payload = firstAuthPayload(win);
    expect(() => answerAgentAuthRequest(payload.requestId, 'once', 1)).not.toThrow();
    await expect(pending).resolves.toBe('once');
  });

  // T7d 安全:应答方须是收到该请求的窗口。别的窗口(或拿到 raw IPC 的调用方)猜/截到 requestId 也不能
  // 替目标窗口放行;其应答被拒(抛 NOT_PENDING)且不消耗该请求,目标窗口之后仍可正常应答。
  it('T7d: answerAgentAuthRequest 拒绝非目标窗口的应答,且不结算该请求', async () => {
    const win1 = makeWin(1);
    const win2 = makeWin(2);
    electronMock.windows = [win1, win2];
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    const payload = firstAuthPayload(win1);
    expect(() => answerAgentAuthRequest(payload.requestId, 'session', 2)).toThrow(
      expect.objectContaining({ code: 'AGENT_AUTH_REQUEST_NOT_PENDING' }),
    );
    expect(() => answerAgentAuthRequest(payload.requestId, 'session', null)).toThrow(
      expect.objectContaining({ code: 'AGENT_AUTH_REQUEST_NOT_PENDING' }),
    );
    expect(() => answerAgentAuthRequest(payload.requestId, 'denied', 1)).not.toThrow();
    await expect(pending).resolves.toBe('denied');
  });

  it('T7e: ipc respond 接线以 IPC sender 所在窗口作为应答方窗口(不信 renderer 自报)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'electron/main/ipc.ts'), 'utf8');
    const start = src.indexOf('AGENT_AUTH_CHANNELS.RESPOND,');
    const block = src.slice(start, src.indexOf('trusted,', start));
    expect(block).toMatch(/BrowserWindow\.fromWebContents\(event\.sender\)\?\.id \?\? null/);
    expect(block).toMatch(/answerAgentAuthRequest\(requestId, decision, senderWindowId\)/);
  });

  it('T8: resolving the same request twice only uses the first decision', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    const payload = firstAuthPayload(win);

    resolveAgentAuthRequest(payload.requestId, 'session');
    resolveAgentAuthRequest(payload.requestId, 'denied');

    await expect(pending).resolves.toBe('session');
  });

  it('T9: resolving a request clears the timeout path', async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    let settled: AgentAuthDecision | null = null;
    const pending = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 }).then(
      (decision) => {
        settled = decision;
        return decision;
      },
    );
    const payload = firstAuthPayload(win);

    resolveAgentAuthRequest(payload.requestId, 'once');
    await expect(pending).resolves.toBe('once');
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_PROMPT_TIMEOUT_MS);

    expect(settled).toBe('once');
  });

  it("T10: _resetPendingForTest denies all pending requests", async () => {
    const win = makeWin(1);
    electronMock.windows = [win];
    const first = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
    // 同一调用方同时只有一个未决弹窗 → 第二条用另一类调用方(external)。
    const second = requestAgentAuth({ method: 'terminal.write', ownerWindowId: 1, external: true });

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
    const pendingAuth = requestAgentAuth({ method: 'terminal.create_session', ownerWindowId: 1 });
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

  // 跨窗口撤销:撤销是全局的(token 旋转 / pending 全清),但「本次启动期间允许」记在各窗口 renderer
  // 的 store 里。只有发起撤销的窗口会重置 → 其它窗口仍 sessionGranted=true,之后的请求被静默放行。
  // 契约:撤销后向所有窗口广播 REVOKED,各 renderer 据此重置授权态。
  it('T16: revoke 向所有存活窗口广播 REVOKED', () => {
    const w1 = makeWin(1);
    const w2 = makeWin(2);
    const dead = makeWin(3, { destroyed: true });
    electronMock.windows = [w1, w2, dead];

    revokeAndKillAgentSessions();

    for (const w of [w1, w2]) {
      expect(w.webContents.send).toHaveBeenCalledWith(AGENT_AUTH_CHANNELS.REVOKED, {});
    }
    expect(dead.webContents.send).not.toHaveBeenCalled();
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

  // 撤销只杀已登记会话;授权已过、PTY 尚未登记的在途 create_session 也须取消(不论调用方)。
  it('revoke 取消所有调用方的在途 agent 终端创建', () => {
    const a = trackAgentTerminalCreate('tok-a');
    const b = trackAgentTerminalCreate('stdio-b');
    try {
      revokeAndKillAgentSessions();
      expect(a.signal.aborted).toBe(true);
      expect(b.signal.aborted).toBe(true);
    } finally {
      a.done();
      b.done();
    }
  });
});

// 退出清理:before-quit 时窗口已隐藏,用户无法再应答授权弹窗;挂在授权上的 HTTP/stdio 工具调用若等
// 无应答超时定时器,mcpHost.close() 会被拖住 → 应用不可见且无法退出。cancelAllAgentAuth 同步把所有未决
// 请求结算为 denied(跨窗口),不发任何 IPC(不是「撤销」语义,不重置 renderer 的会话授权)。
describe('agent-auth-service: cancelAllAgentAuth(退出清理)', () => {
  it('T17: 所有窗口的未决请求立即 denied,返回取消数,不发 IPC', async () => {
    const a = makeWin(1);
    const b = makeWin(2);
    electronMock.windows = [a, b];
    const p1 = requestAgentAuth({ method: 'tools/call', ownerWindowId: 1 });
    const p2 = requestAgentAuth({ method: 'tools/call', ownerWindowId: 2 });
    a.webContents.send.mockClear();
    b.webContents.send.mockClear();

    expect(cancelAllAgentAuth()).toBe(2);
    await expect(p1).resolves.toBe('denied');
    await expect(p2).resolves.toBe('denied');
    expect(a.webContents.send).not.toHaveBeenCalled();
    expect(b.webContents.send).not.toHaveBeenCalled();
    // 已结算:再次调用无可取消项
    expect(cancelAllAgentAuth()).toBe(0);
  });
});
