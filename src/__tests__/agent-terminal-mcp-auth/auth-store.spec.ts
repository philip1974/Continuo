// BDD: agent-terminal-mcp-auth
// agent 控制内置 terminal 的授权 store。每个 test 重置状态。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useAgentAuthStore,
  _resetAgentAuthForTest,
} from '../../stores/agent-auth.store';

beforeEach(() => {
  _resetAgentAuthForTest();
});

// race(R88):main 端 5min timeout 把请求 resolve 为 denied 但不通知 renderer。renderer 端同 TTL
// 本地超时:过期 → deny + 清 pending,避免失效弹窗滞留 + 阻塞后续 agent auth 请求。
describe('race(R88) · pending 同 TTL 本地超时自清', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5min 无应答 → ensure resolve denied + pending 清空 + 后续请求不被阻塞', async () => {
    vi.useFakeTimers();
    const p = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    expect(useAgentAuthStore.getState().pending).not.toBeNull();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(p).resolves.toBe('denied');
    expect(useAgentAuthStore.getState().pending).toBeNull();

    // 旧弹窗已自清 → 新请求能重新挂起(不再因 pending!==null 立即拒)。
    void useAgentAuthStore.getState().ensure({ method: 'terminal.write' });
    expect(useAgentAuthStore.getState().pending?.method).toBe('terminal.write');
  });

  it('超时前用户 grant once → 不被超时 deny 覆盖(timer 已清)', async () => {
    vi.useFakeTimers();
    const p = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('once');
    await expect(p).resolves.toBe('once');
    // 推进过 TTL:不应再触发(grant 已 clearPendingTimer)。
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(useAgentAuthStore.getState().pending).toBeNull();
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
      .ensure({ method: 'terminal.create_session' });
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

  it('agentLabel 传入 → 进 pending', () => {
    void useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session', agentLabel: 'codex' });
    expect(useAgentAuthStore.getState().pending?.agentLabel).toBe('codex');
  });

  it("sessionGranted=true → 立即 resolve session,不设 pending", async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    const decision = await useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    expect(decision).toBe('session');
    expect(useAgentAuthStore.getState().pending).toBeNull();
  });

  it("已有 pending → 第二条 ensure 立即 resolve denied", async () => {
    const first = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    const second = await useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    expect(second).toBe('denied');
    // 第一个仍在 pending
    expect(useAgentAuthStore.getState().pending).not.toBeNull();
    useAgentAuthStore.getState().deny();
    expect(await first).toBe('denied');
  });

  it('每次 ensure 生成新 requestId(uuid)', () => {
    void useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    const id1 = useAgentAuthStore.getState().pending!.requestId;
    useAgentAuthStore.getState().deny();
    void useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    const id2 = useAgentAuthStore.getState().pending!.requestId;
    expect(id1).not.toBe(id2);
  });

  it('sessionGranted=true 时多个并发 ensure 都直接通过', async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    const a = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    const b = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
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
      .ensure({ method: 'terminal.create_session' });
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
});

describe("grant('session')", () => {
  it("Promise resolve 'session' + 清 pending + sessionGranted=true", async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('session');
    expect(await p).toBe('session');
    const s = useAgentAuthStore.getState();
    expect(s.pending).toBeNull();
    expect(s.sessionGranted).toBe(true);
  });

  it("session 后续 ensure 直接 'session'", async () => {
    const p = useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    useAgentAuthStore.getState().grant('session');
    await p;
    const next = await useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    expect(next).toBe('session');
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
      .ensure({ method: 'terminal.create_session' });
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

  it('revoke 后再 ensure → 重新弹窗(不再直接通过)', async () => {
    useAgentAuthStore.setState({ sessionGranted: true });
    // 先验证已授权
    expect(
      await useAgentAuthStore
        .getState()
        .ensure({ method: 'terminal.create_session' }),
    ).toBe('session');
    // 撤销
    useAgentAuthStore.getState().revoke();
    // 再 ensure 应该挂起(等用户)
    void useAgentAuthStore
      .getState()
      .ensure({ method: 'terminal.create_session' });
    expect(useAgentAuthStore.getState().pending).not.toBeNull();
  });
});
