import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appendFsScopeQueueId,
  removeFsScopeQueueId,
  usePermissionPromptStore,
} from '../../plugins/permissions/promptStore';

beforeEach(() => {
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
    fsScopePending: {},
    fsScopeQueue: [],
    currentFsScope: null,
  });
});

// race(R89,R88 同型):main scope-request-correlator 的 TTL(300s)到点只在 main reject pending,
// 不通知 renderer 清 fs-scope prompt。renderer 端同 TTL 本地超时:过期 → deny + 推进队列,避免过期
// 弹窗滞留挡住后续 scope 请求。
describe('race(R89) · fs-scope prompt 同 TTL 本地超时自清', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('300s 无应答 → requestFsScope resolve deny + currentFsScope 清空', async () => {
    vi.useFakeTimers();
    const p = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '/x', mode: 'r', displayPath: '/x' }],
    });
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r1');

    await vi.advanceTimersByTimeAsync(300_000);
    await expect(p).resolves.toBe('deny');
    expect(usePermissionPromptStore.getState().currentFsScope).toBeNull();
  });

  it('队首请求超时 → 队列推进到下一个,后续请求得以显示', async () => {
    vi.useFakeTimers();
    const p1 = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '/a', mode: 'r', displayPath: '/a' }],
    });
    // r2 晚 1s 到达 → 其 TTL deadline 比 r1 晚,推进到 r1 deadline 时 r2 仍 pending。
    await vi.advanceTimersByTimeAsync(1_000);
    const p2 = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r2',
      pluginId: 'p2',
      scopes: [{ path: '/b', mode: 'r', displayPath: '/b' }],
    });
    // 队首是 r1。
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r1');

    // 推进到 r1 deadline(从 r1 起共 300s)→ r1 超时 deny + 推进到 r2;r2 尚有 1s 余,仍 pending。
    await vi.advanceTimersByTimeAsync(299_000);
    await expect(p1).resolves.toBe('deny');
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r2');

    // r2 用户授权(超时前)。
    usePermissionPromptStore.getState().grantFsScope('r2');
    await expect(p2).resolves.toBe('grant');
  });

  it('超时前 grant → 不被超时 deny 覆盖(timer 已清)', async () => {
    vi.useFakeTimers();
    const p = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '/x', mode: 'r', displayPath: '/x' }],
    });
    usePermissionPromptStore.getState().grantFsScope('r1');
    await expect(p).resolves.toBe('grant');
    await vi.advanceTimersByTimeAsync(300_000); // 不应再触发
    expect(usePermissionPromptStore.getState().currentFsScope).toBeNull();
  });
});

describe('usePermissionPromptStore', () => {
  it('removeFsScopeQueueId 按需复制队列,不通过 filter 重建', () => {
    const queue = ['r1', 'r2', 'r1', 'r3'];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const next = removeFsScopeQueueId(queue, 'r1');
      const filterCallsDuringRemove = filterSpy.mock.calls.length;
      expect([...next]).toEqual(['r2', 'r3']);
      expect(filterCallsDuringRemove).toBe(0);
      expect(removeFsScopeQueueId.toString()).not.toContain('.push(');
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('removeFsScopeQueueId 未命中 → 返回原队列引用', () => {
    const queue = ['r1', 'r2'];
    expect(removeFsScopeQueueId(queue, 'missing')).toBe(queue);
  });

  it('appendFsScopeQueueId 预分配追加,不通过 spread/push 拷贝', () => {
    const queue = ['r1'];
    expect(appendFsScopeQueueId(queue, 'r2')).toEqual(['r1', 'r2']);
    expect(appendFsScopeQueueId.toString()).not.toContain('.push(');
    expect(appendFsScopeQueueId.toString()).not.toContain('...');
  });

  it('request 设 pending,grant 后 Promise resolve 收授权列表', async () => {
    const promise = usePermissionPromptStore
      .getState()
      .request('p', ['fs', 'network']);
    expect(usePermissionPromptStore.getState().pending).toEqual({
      pluginId: 'p',
      perms: ['fs', 'network'],
    });
    usePermissionPromptStore.getState().grant(['fs']);
    expect(await promise).toEqual(['fs']);
    expect(usePermissionPromptStore.getState().pending).toBeNull();
  });

  it('denyAll → Promise resolve []', async () => {
    const promise = usePermissionPromptStore
      .getState()
      .request('p', ['fs']);
    usePermissionPromptStore.getState().denyAll();
    expect(await promise).toEqual([]);
  });

  it('无 pending 时 grant 不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = usePermissionPromptStore.subscribe(listener);

    try {
      usePermissionPromptStore.getState().grant(['fs']);

      expect(usePermissionPromptStore.getState().pending).toBeNull();
      expect(usePermissionPromptStore.getState().resolve).toBeNull();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('无 pending 时 denyAll 不通知订阅者', () => {
    const listener = vi.fn();
    const unsubscribe = usePermissionPromptStore.subscribe(listener);

    try {
      usePermissionPromptStore.getState().denyAll();

      expect(usePermissionPromptStore.getState().pending).toBeNull();
      expect(usePermissionPromptStore.getState().resolve).toBeNull();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('同时只能一个 pending,二次 request → 立即 resolve([])', async () => {
    const first = usePermissionPromptStore
      .getState()
      .request('p1', ['fs']);
    const second = usePermissionPromptStore
      .getState()
      .request('p2', ['shell']);
    expect(await second).toEqual([]); // 立刻拒
    // 第一个还在 pending(不被覆盖)
    expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('p1');
    usePermissionPromptStore.getState().grant(['fs']);
    expect(await first).toEqual(['fs']);
  });
});
