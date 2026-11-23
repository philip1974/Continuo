// BDD: agent-terminal-mcp-auth
// agent 控制内置 terminal 的授权 store。每个 test 重置状态。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getAgentAuthEpoch,
  hasAnySessionGrant,
  useAgentAuthStore,
  _resetAgentAuthForTest,
} from '../../stores/agent-auth.store';
import { AGENT_AUTH_PROMPT_TIMEOUT_MS } from '../../../electron/shared/agent-auth-channels';

beforeEach(() => {
  _resetAgentAuthForTest();
});

// race(R88):请求过期(main 端无应答超时 / 排队兜底 / 取消)只有 main 一个来源:main 结算后发 CANCELLED,
// renderer 以 cancel(requestId) 撤掉弹窗、以 'cancelled' 收口(main 已按 denied 结算并删除;再 respond 只会拿到
// NOT_PENDING)。renderer 不自行计时。
describe('race(R88) · main 的取消通知撤掉弹窗', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancel(requestId) → ensure resolve cancelled + pending 清空 + 后续请求不被阻塞', async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: 'r-1', method: 'terminal.create_session' });
    expect(useAgentAuthStore.getState().pending?.requestId).toBe('r-1');

    useAgentAuthStore.getState().cancel('r-1');

    await expect(p).resolves.toBe('cancelled');
    expect(useAgentAuthStore.getState().pending).toBeNull();
    void useAgentAuthStore.getState().ensure({ requestId: 'r-2', method: 'terminal.write' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('terminal.write');
  });

  it('不自行计时:无应答再久也不自清(等 main 通知);未知 id 的 cancel 无效', async () => {
    vi.useFakeTimers();
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: 'r-3', method: 'terminal.create_session' });
    await vi.advanceTimersByTimeAsync(AGENT_AUTH_PROMPT_TIMEOUT_MS * 10);
    useAgentAuthStore.getState().cancel('r-unknown');
    expect(useAgentAuthStore.getState().pending?.requestId).toBe('r-3');
    useAgentAuthStore.getState().grant('once');
    await expect(p).resolves.toBe('once');
  });
});

describe('agent-auth.store · 初态', () => {
  it('pending=null, sessionGranted=false', () => {
    const s = useAgentAuthStore.getState();
    expect(s.pending).toBeNull();
    expect(s.sessionGranted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// ensure
// ────────────────────────────────────────────────────────────

describe('ensure', () => {
  it('首次调 → 设 pending,Promise 挂起', () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    const pending = useAgentAuthStore.getState().pending;
    expect(pending).not.toBeNull();
    expect(pending!.method).toBe('terminal.create_session');
    expect(typeof pending!.requestId).toBe('string');
    expect(pending!.requestId.length).toBeGreaterThan(0);
    // Promise 还没 resolve
    let resolved = false;
    void p.then(() => {
      resolved = true;
    });
    return Promise.resolve().then(() => {
      expect(resolved).toBe(false);
    });
  });

  it("sessionGranted=true → 立即 resolve session,不设 pending", async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    const decision = await useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(decision).toBe('session');
    expect(useAgentAuthStore.getState().pending).toBeNull();
  });

  it("已有 pending → 第二条 ensure 立即 resolve denied", async () => {
    const first = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    const second = await useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(second).toBe('denied');
    // 第一个仍在 pending
    expect(useAgentAuthStore.getState().pending).not.toBeNull();
    useAgentAuthStore.getState().deny();
    expect(await first).toBe('denied');
  });

  it('每次 ensure 生成新 requestId(uuid)', () => {
    void useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    const id1 = useAgentAuthStore.getState().pending!.requestId;
    useAgentAuthStore.getState().deny();
    void useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    const id2 = useAgentAuthStore.getState().pending!.requestId;
    expect(id1).not.toBe(id2);
  });

  it('sessionGranted=true 时多个并发 ensure 都直接通过', async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    const a = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    const b = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(await a).toBe('session');
    expect(await b).toBe('session');
    expect(useAgentAuthStore.getState().pending).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// grant
// ────────────────────────────────────────────────────────────

describe("grant('once')", () => {
  it("Promise resolve 'once' + 清 pending + sessionGranted 不变", async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('once');
    expect(await p).toBe('once');
    const s = useAgentAuthStore.getState();
    expect(s.pending).toBeNull();
    expect(s.sessionGranted).toBe(false);
  });

  it("无 pending → no-op,不抛", () => {
    expect(() => useAgentAuthStore.getState().grant('once')).not.toThrow();
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
  });

  it("无 pending 且 grant('once') 不改变状态时不通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = useAgentAuthStore.subscribe(listener);

    try {
      useAgentAuthStore.getState().grant('once');

      expect(useAgentAuthStore.getState().pending).toBeNull();
      expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

describe("grant('session')", () => {
  // 安全:grant('session') 只结算当前请求,不立即记域授权 —— 该请求在 main 可能已被撤销 / 超时删除。
  // 域授权须待 main 确认(respond ok)后由应答方调 confirmSessionGrant。
  it("Promise resolve 'session' + 清 pending,但 sessionGranted 仍为 false(待 main 确认)", async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('session');
    expect(await p).toBe('session');
    const s = useAgentAuthStore.getState();
    expect(s.pending).toBeNull();
    expect(s.sessionGranted).toBe(false);
  });

  it("confirmSessionGrant 后,后续 ensure 直接 'session'", async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('session');
    await p;
    useAgentAuthStore
      .getState()
      .confirmSessionGrant('terminal.create_session', getAgentAuthEpoch());
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
    const next = await useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(next).toBe('session');
  });

  it('确认前发生 revoke → 迟到的 confirmSessionGrant 被忽略(不复活已撤销授权)', async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('session');
    await p;
    const epoch = getAgentAuthEpoch();
    useAgentAuthStore.getState().revoke();
    useAgentAuthStore.getState().confirmSessionGrant('terminal.create_session', epoch);
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// deny
// ────────────────────────────────────────────────────────────

describe('deny', () => {
  it("Promise resolve 'denied' + 清 pending + sessionGranted 不变", async () => {
    useAgentAuthStore.setState({ sessionGranted: false });
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    useAgentAuthStore.getState().deny();
    expect(await p).toBe('denied');
    const s = useAgentAuthStore.getState();
    expect(s.pending).toBeNull();
    expect(s.sessionGranted).toBe(false);
  });

  it("deny 时 sessionGranted=true(用户授权了 session 但又改主意拒绝当前)→ 不影响 sessionGranted", async () => {
    // 这条边界:理论上 grant('session') 后不会再 pending(ensure 直接通过),
    // 但若 sessionGranted=true 时仍走到 deny(直接 setState pending 测),
    // deny 不应自动撤销 sessionGranted。
    useAgentAuthStore.setState({
      sessionGranted: true,
      pending: { requestId: 'x', method: 'forced' },
    });
    useAgentAuthStore.getState().deny();
    expect(useAgentAuthStore.getState().sessionGranted).toBe(true);
  });

  it('无 pending → no-op,不抛', () => {
    expect(() => useAgentAuthStore.getState().deny()).not.toThrow();
  });

  it('无 pending 且状态不变时不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = useAgentAuthStore.subscribe(listener);

    try {
      useAgentAuthStore.getState().deny();

      expect(useAgentAuthStore.getState().pending).toBeNull();
      expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

// ────────────────────────────────────────────────────────────
// revoke
// ────────────────────────────────────────────────────────────

describe('revoke', () => {
  it('sessionGranted=true → false', () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    useAgentAuthStore.getState().revoke();
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
  });

  it('pending 不变(用户仍可决定当前请求)', () => {
    useAgentAuthStore.setState({
      sessionGranted: true,
      pending: { requestId: 'x', method: 'foo' },
    });
    useAgentAuthStore.getState().revoke();
    expect(useAgentAuthStore.getState().pending).toEqual({
      requestId: 'x',
      method: 'foo',
    });
  });

  it('sessionGranted 已为 false 时 revoke 不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = useAgentAuthStore.subscribe(listener);

    try {
      useAgentAuthStore.getState().revoke();

      expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('revoke 后再 ensure → 重新弹窗(不再直接通过)', async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    // 先验证已授权
    expect(
      await useAgentAuthStore
        .getState()
        .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' }),
    ).toBe('session');
    // 撤销
    useAgentAuthStore.getState().revoke();
    // 再 ensure 应该挂起(等用户)
    void useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(useAgentAuthStore.getState().pending).not.toBeNull();
  });
});

// main 已撤销(本窗口撤销成功 / 其它窗口撤销的 REVOKED 广播):main 已旋转 token 并把全部 pending 结算为
// denied 删除。renderer 须与本地 revoke 同样重置(epoch+1、清两个域的 session 授权),并取消残留弹窗;
// 取消结果是 'cancelled'(main 已结算,应答方不得再向 main respond,否则收到 NOT_PENDING 误报失败)。
describe('applyMainRevoked', () => {
  it('清两个域的 session 授权 + epoch+1', () => {
    useAgentAuthStore.setState({ sessionGranted: true, debugSessionGranted: true });
    const before = getAgentAuthEpoch();
    useAgentAuthStore.getState().applyMainRevoked();
    const s = useAgentAuthStore.getState();
    expect(s.sessionGranted).toBe(false);
    expect(s.debugSessionGranted).toBe(false);
    expect(getAgentAuthEpoch()).toBe(before + 1);
  });

  it("残留 pending → 清空,挂起的 ensure resolve 'cancelled'", async () => {
    const p = useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(useAgentAuthStore.getState().pending).not.toBeNull();
    useAgentAuthStore.getState().applyMainRevoked();
    expect(useAgentAuthStore.getState().pending).toBeNull();
    await expect(p).resolves.toBe('cancelled');
  });

  it('撤销前在途的 session 应答迟到确认 → 不复活授权', () => {
    const epoch = getAgentAuthEpoch();
    useAgentAuthStore.getState().applyMainRevoked();
    useAgentAuthStore.getState().confirmSessionGrant('terminal.create_session', epoch);
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
  });
});

// 授权分域:终端与 debug 是两个独立的「本次启动期间允许」。此前只有一个标志位 —— 用户对终端点了
// 「本次启动期间允许」之后,debug 工具(启动进程、读变量、执行表达式)也被静默放行,用户从未见过 debug 授权弹窗。
describe('授权分域:terminal 与 debug 各自记「本次启动期间允许」', () => {
  it('对终端授权 session 后,debug 请求仍然弹窗(不被短路)', async () => {
    const terminal = useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('session');
    await expect(terminal).resolves.toBe('session');

    void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'debug.launch' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('debug.launch');
    useAgentAuthStore.getState().deny();
  });

  it('对 debug 授权 session 后:debug 请求直接通过,终端请求仍然弹窗', async () => {
    const debug = useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'debug.launch' });
    useAgentAuthStore.getState().grant('session');
    await expect(debug).resolves.toBe('session');
    useAgentAuthStore.getState().confirmSessionGrant('debug.launch', getAgentAuthEpoch());
    expect(useAgentAuthStore.getState().debugSessionGranted).toBe(true);
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);

    await expect(useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'debug.*' })).resolves.toBe('session');
    expect(useAgentAuthStore.getState().pending).toBeNull();

    void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_input' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('terminal.send_input');
    useAgentAuthStore.getState().deny();
  });

  it('revoke 同时撤销两个域', () => {
    useAgentAuthStore.setState({ sessionGranted: true, debugSessionGranted: true });
    useAgentAuthStore.getState().revoke();
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
    expect(useAgentAuthStore.getState().debugSessionGranted).toBe(false);
  });

  it('非 debug 的 method(含未知 method)归终端域', async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    await expect(useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'something.else' })).resolves.toBe(
      'session',
    );
  });
});

// 安全:插件注册的 MCP 工具(method 以 plugin. 开头)独立成 plugin 域。插件工具能做任意插件能力
// (如 git stage/commit),对终端点「本次启动期间允许」不应静默放行插件工具,反之亦然。
describe('授权分域:plugin 域独立于 terminal / debug', () => {
  it('终端 + debug 均已 session 授权,插件工具请求仍然弹窗', () => {
    useAgentAuthStore.setState({ sessionGranted: true, debugSessionGranted: true });
    void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'plugin.git.stage' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('plugin.git.stage');
    useAgentAuthStore.getState().deny();
  });

  it('plugin 域 session 授权后:插件工具直接通过,终端 / debug 请求仍然弹窗', async () => {
    const p = useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'plugin.git.stage' });
    useAgentAuthStore.getState().grant('session');
    await expect(p).resolves.toBe('session');
    useAgentAuthStore.getState().confirmSessionGrant('plugin.git.stage', getAgentAuthEpoch());
    expect(useAgentAuthStore.getState().pluginSessionGranted).toBe(true);
    expect(useAgentAuthStore.getState().sessionGranted).toBe(false);
    expect(useAgentAuthStore.getState().debugSessionGranted).toBe(false);

    await expect(
      useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'plugin.other.tool' }),
    ).resolves.toBe('session');

    void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_input' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('terminal.send_input');
    useAgentAuthStore.getState().deny();
  });

  it('revoke 同时撤销 plugin 域', () => {
    useAgentAuthStore.setState({ pluginSessionGranted: true });
    useAgentAuthStore.getState().revoke();
    expect(useAgentAuthStore.getState().pluginSessionGranted).toBe(false);
  });
});

// 安全(F2):未发 `_continuo/hello` 的 stdio 连接(外部客户端,未绑定 Continuo 终端)用独立的 external 授权状态,
// 不复用任何窗口的「本次启动期间允许」,也不写入窗口级授权。否则窗口 B 终端里的 agent 绕过 proxy 直连
// mcp.sock 不发 hello,即可借主窗 A 已有的授权静默 create_session / debug_launch。
describe('授权分调用方:external(未绑定终端)独立于窗口级授权', () => {
  it('窗口级三个域均已 session 授权,external 请求仍然弹窗', () => {
    useAgentAuthStore.setState({
      sessionGranted: true,
      debugSessionGranted: true,
      pluginSessionGranted: true,
    });
    void useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session', external: true });
    expect(useAgentAuthStore.getState().pending?.method).toBe('terminal.create_session');
    expect(useAgentAuthStore.getState().pending?.external).toBe(true);
    useAgentAuthStore.getState().deny();
  });

  it('external session 授权只记在 external 同域:不写窗口级授权,窗口请求 / external 其它域仍弹窗', async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session', external: true });
    useAgentAuthStore.getState().grant('session');
    await expect(p).resolves.toBe('session');
    useAgentAuthStore
      .getState()
      .confirmSessionGrant('terminal.create_session', getAgentAuthEpoch(), true);
    const s = useAgentAuthStore.getState();
    expect(s.externalSessionGranted).toBe(true);
    expect(s.sessionGranted).toBe(false);

    await expect(
      useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'terminal.read_output', external: true }),
    ).resolves.toBe('session');

    void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'terminal.read_output' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('terminal.read_output');
    useAgentAuthStore.getState().deny();

    void useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'debug.launch', external: true });
    expect(useAgentAuthStore.getState().pending?.method).toBe('debug.launch');
    useAgentAuthStore.getState().deny();
  });

  it('revoke 同时撤销 external 各域', () => {
    useAgentAuthStore.setState({
      externalSessionGranted: true,
      externalDebugSessionGranted: true,
    });
    useAgentAuthStore.getState().revoke();
    const s = useAgentAuthStore.getState();
    expect(s.externalSessionGranted).toBe(false);
    expect(s.externalDebugSessionGranted).toBe(false);
  });

  // 纵深:main plugin-mcp-bridge 在授权前已拒绝外部客户端调插件工具;store 对该组合也直接拒,
  // 不弹窗、不记任何授权(也就没有 external 插件域状态)。
  it('external 调插件工具(plugin.*)→ 直接 denied,不弹窗,confirmSessionGrant 也不记授权', async () => {
    await expect(
      useAgentAuthStore.getState().ensure({ requestId: crypto.randomUUID(), method: 'plugin.git.commit', external: true }),
    ).resolves.toBe('denied');
    expect(useAgentAuthStore.getState().pending).toBeNull();

    useAgentAuthStore.getState().confirmSessionGrant('plugin.git.commit', getAgentAuthEpoch(), true);
    const s = useAgentAuthStore.getState();
    expect(hasAnySessionGrant(s)).toBe(false);
    expect('externalPluginSessionGranted' in s).toBe(false);
  });
});
