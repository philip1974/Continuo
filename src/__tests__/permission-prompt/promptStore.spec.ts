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

  it('removeFsScopeQueueId 删除到空时复用稳定空队列', () => {
    const empty = removeFsScopeQueueId(['r1'], 'r1');
    expect(empty).toEqual([]);
    expect(removeFsScopeQueueId(['r2'], 'r2')).toBe(empty);
    expect(removeFsScopeQueueId([], 'missing')).toBe(empty);
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

  // 此前二次 request 立即 resolve([]);调用方 ensureAuthorized 把空数组当「用户全拒」持久化 →
  // 插件 A 的弹窗开着时插件 B 的权限被静默永久拒绝,用户从未见过 B 的弹窗。改为排队。
  it('同时只显示一个弹窗;弹窗占用时的 request 排队,前一个决定后依次弹出', async () => {
    const first = usePermissionPromptStore.getState().request('p1', ['fs']);
    const second = usePermissionPromptStore.getState().request('p2', ['shell']);
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false); // 不被当成「用户拒绝」提前结算
    expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('p1');

    usePermissionPromptStore.getState().grant(['fs']);
    expect(await first).toEqual(['fs']);
    // 轮到 p2
    expect(usePermissionPromptStore.getState().pending).toEqual({ pluginId: 'p2', perms: ['shell'] });
    usePermissionPromptStore.getState().denyAll();
    expect(await second).toEqual([]);
    expect(usePermissionPromptStore.getState().pending).toBeNull();
  });

  it('处理非队首 fs-scope 请求时复用当前弹窗引用', async () => {
    const p1 = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '/a', mode: 'r', displayPath: '/a' }],
    });
    const p2 = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r2',
      pluginId: 'p2',
      scopes: [{ path: '/b', mode: 'r', displayPath: '/b' }],
    });
    const current = usePermissionPromptStore.getState().currentFsScope;

    usePermissionPromptStore.getState().grantFsScope('r2');

    expect(await p2).toBe('grant');
    expect(usePermissionPromptStore.getState().currentFsScope).toBe(current);
    usePermissionPromptStore.getState().denyFsScope('r1');
    expect(await p1).toBe('deny');
  });
});
