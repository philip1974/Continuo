// 安全:external 调用方与窗口内 agent 在 renderer 各占一个授权槽,互不顶掉;同一时刻仍只显示一个弹窗。
// 行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetAgentAuthForTest, useAgentAuthStore } from '../../stores/agent-auth.store';

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
    const ext = store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_text', external: true });
    const inWindow = store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
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
    const inWindow = store().ensure({ requestId: crypto.randomUUID(), method: 'debug.launch' });
    const ext = store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_text', external: true });
    expect(store().pending).toMatchObject({ method: 'debug.launch' });
    store().grant('once');
    await expect(inWindow).resolves.toBe('once');
    expect(store().pending).toMatchObject({ external: true });
    store().deny();
    await expect(ext).resolves.toBe('denied');
  });

  it('同一类调用方已占槽(显示中或排队中)→ 再来的立即 denied', async () => {
    void store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_text', external: true });
    void store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    await expect(store().ensure({ requestId: crypto.randomUUID(), method: 'debug.launch', external: true })).resolves.toBe('denied');
    await expect(store().ensure({ requestId: crypto.randomUUID(), method: 'debug.launch' })).resolves.toBe('denied');
    expect(store().pending).toMatchObject({ external: true });
  });

  it('显示中的请求被 main 取消(超时等)→ cancelled 收口,排队的显示出来;排队中的也可被单独取消', async () => {
    const ext = store().ensure({ requestId: 'ext-1', method: 'terminal.send_text', external: true });
    const inWindow = store().ensure({ requestId: 'win-1', method: 'terminal.create_session' });
    expect(store().pending).toMatchObject({ requestId: 'ext-1' });

    store().cancel('ext-1');
    await expect(ext).resolves.toBe('cancelled');
    expect(store().pending).toMatchObject({ requestId: 'win-1', method: 'terminal.create_session' });

    store().cancel('win-1');
    await expect(inWindow).resolves.toBe('cancelled');
    expect(store().pending).toBeNull();
  });

  it('main 撤销 → 显示中与排队中的请求都以 cancelled 收口,两个槽都释放', async () => {
    const inWindow = store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    const ext = store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_text', external: true });
    store().applyMainRevoked();
    await expect(inWindow).resolves.toBe('cancelled');
    await expect(ext).resolves.toBe('cancelled');
    expect(store().pending).toBeNull();
    void store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.send_text', external: true });
    void store().ensure({ requestId: crypto.randomUUID(), method: 'terminal.create_session' });
    expect(store().pending).toMatchObject({ external: true });
  });
});
