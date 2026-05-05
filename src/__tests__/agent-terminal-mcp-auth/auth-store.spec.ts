// BDD: agent-terminal-mcp-auth
// agent 控制内置 terminal 的授权 store。每个 test 重置状态。

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAgentAuthStore,
  _resetAgentAuthForTest,
} from '../../stores/agent-auth.store';

beforeEach(() => {
  _resetAgentAuthForTest();
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
