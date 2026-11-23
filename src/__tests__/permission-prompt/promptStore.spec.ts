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

// fs-scope 请求的过期只有一个来源:main 的 scope-request-correlator(TTL 到点 / 插件注销)发
// SCOPE_REQUEST_CANCELLED,bridge 收到后走 denyFsScope 撤弹窗并推进队列(见 plugin-fs-scope-bridge/)。
// renderer 不再自设同值的本地超时(R89 的旧做法):它总是先于 main 的周期清扫触发,随后回传的 deny 被 main
// 以「已过期」拒绝,用户会看到一条误导的「决定未生效」错误提示。
describe('fs-scope prompt 不自设本地超时,过期由 main 的取消通知收口', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('超过 TTL 仍无应答 → renderer 不自行 deny;收到取消(denyFsScope)才收口并推进队列', async () => {
    vi.useFakeTimers();
    const settled: string[] = [];
    const p1 = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r1',
      pluginId: 'p1',
      scopes: [{ path: '/a', mode: 'r', displayPath: '/a' }],
    });
    void p1.then((d) => settled.push(`r1:${d}`));
    const p2 = usePermissionPromptStore.getState().requestFsScope({
      requestId: 'r2',
      pluginId: 'p2',
      scopes: [{ path: '/b', mode: 'r', displayPath: '/b' }],
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toEqual([]);
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r1');

    // main 的取消通知 → bridge 调 denyFsScope
    usePermissionPromptStore.getState().denyFsScope('r1');
    await expect(p1).resolves.toBe('deny');
    expect(usePermissionPromptStore.getState().currentFsScope?.requestId).toBe('r2');

    usePermissionPromptStore.getState().grantFsScope('r2');
    await expect(p2).resolves.toBe('grant');
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
