// 安全:external 调用方与窗口内 agent 在 renderer 各占一个授权槽,互不顶掉;同一时刻仍只显示一个弹窗。
// 行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentAuthForTest, useAgentAuthStore } from '../../stores/agent-auth.store';
import { AGENT_AUTH_PROMPT_TIMEOUT_MS } from '../../../electron/shared/agent-auth-channels';

const store = () => useAgentAuthStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  _resetAgentAuthForTest();
});
afterEach(() => {
  _resetAgentAuthForTest();
  vi.useRealTimers();
});

describe('agent-auth store:按调用方类别分槽', () => {
  it('external 弹窗显示中 → 窗口内 agent 的首次请求不被自动拒绝,排在后面,external 落定后显示', async () => {
    const ext = store().ensure({ method: 'terminal.send_text', external: true });
    const inWindow = store().ensure({ method: 'terminal.create_session' });
    let inWindowSettled = false;
    void inWindow.then(() => {
      inWindowSettled = true;
    });
    await Promise.resolve();
    expect(inWindowSettled).toBe(false);
    // 不堆叠:显示的仍是 external 那一个。
    expect(store().pending).toMatchObject({ method: 'terminal.send_text', external: true });

    store().deny();
    await expect(ext).resolves.toBe('denied');
    expect(store().pending).toMatchObject({ method: 'terminal.create_session' });
    expect(store().pending?.external).toBeUndefined();

    store().grant('once');
    await expect(inWindow).resolves.toBe('once');
    expect(store().pending).toBeNull();
  });

  it('反向:窗口内弹窗显示中,external 请求排队', async () => {
    const inWindow = store().ensure({ method: 'debug.launch' });
    const ext = store().ensure({ method: 'terminal.send_text', external: true });
    expect(store().pending).toMatchObject({ method: 'debug.launch' });
    store().grant('once');
    await expect(inWindow).resolves.toBe('once');
    expect(store().pending).toMatchObject({ external: true });
    store().deny();
    await expect(ext).resolves.toBe('denied');
  });

  it('同一类调用方已占槽(显示中或排队中)→ 再来的立即 denied', async () => {
    void store().ensure({ method: 'terminal.send_text', external: true });
    void store().ensure({ method: 'terminal.create_session' });
    await expect(store().ensure({ method: 'debug.launch', external: true })).resolves.toBe('denied');
    await expect(store().ensure({ method: 'debug.launch' })).resolves.toBe('denied');
    expect(store().pending).toMatchObject({ external: true });
  });

  it('各请求从开始显示起超时(cancelled);显示中的超时后,排队的显示出来并重新计满 2 分钟', async () => {
    const ext = store().ensure({ method: 'terminal.send_text', external: true });
    vi.advanceTimersByTime(60_000);
    const inWindow = store().ensure({ method: 'terminal.create_session' });
    let inWindowSettled = false;
    void inWindow.then(() => {
      inWindowSettled = true;
    });
    vi.advanceTimersByTime(AGENT_AUTH_PROMPT_TIMEOUT_MS - 60_000);
    await expect(ext).resolves.toBe('cancelled');
    // external 超时 → 排队的窗口请求显示出来,从此刻起计 2 分钟(与 main 一致)。
    expect(store().pending).toMatchObject({ method: 'terminal.create_session' });
    vi.advanceTimersByTime(AGENT_AUTH_PROMPT_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(inWindowSettled).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(inWindow).resolves.toBe('cancelled');
    expect(store().pending).toBeNull();
  });

  it('main 撤销 → 显示中与排队中的请求都以 cancelled 收口,两个槽都释放', async () => {
    const inWindow = store().ensure({ method: 'terminal.create_session' });
    const ext = store().ensure({ method: 'terminal.send_text', external: true });
    store().applyMainRevoked();
    await expect(inWindow).resolves.toBe('cancelled');
    await expect(ext).resolves.toBe('cancelled');
    expect(store().pending).toBeNull();
    void store().ensure({ method: 'terminal.send_text', external: true });
    void store().ensure({ method: 'terminal.create_session' });
    expect(store().pending).toMatchObject({ external: true });
  });
});
