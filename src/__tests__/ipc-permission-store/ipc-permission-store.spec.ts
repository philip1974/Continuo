// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import {
  IpcPermissionStore,
  parsePermissionState,
} from '../../plugins/permissions/IpcPermissionStore';

interface FakePerm {
  readPermissions: ReturnType<typeof vi.fn>;
  mutatePluginPermissions?: ReturnType<typeof vi.fn>;
}

function installFakeApi(perm: FakePerm): void {
  Object.defineProperty(window, 'api', {
    value: { plugins: perm },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  vi.restoreAllMocks();
});

describe('IpcPermissionStore.get', () => {
  it('首次 get → 触发 readPermissions IPC,后续 get 命中 cache', async () => {
    const readPermissions = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        'p1': [{ permission: 'fs', granted: true, decidedAt: 100 }],
      },
    });
    installFakeApi({ readPermissions });

    const store = new IpcPermissionStore();
    const a = await store.get('p1');
    const b = await store.get('p1');
    const c = await store.get('p2');
    const d = await store.get('p3');

    expect(a).toEqual([{ permission: 'fs', granted: true, decidedAt: 100 }]);
    expect(b).toEqual(a);
    expect(c).toEqual([]);
    expect(d).toBe(c);
    expect(readPermissions).toHaveBeenCalledTimes(1);
  });

  // 数据安全(复查 P1,main #20 的 renderer 对偶):读权限失败(EACCES/EIO 经 main
  // safeHandle → ok:false)= 当前权限态未知。绝不缓存空表 —— 否则 grant/deny/clearDenied
  // 基于 {} 做 RMW,用部分 record 覆盖该 plugin 已落盘的 decisions/pathScopes。ensureLoaded
  // 抛 → 调用侧 fail-closed 不在未知态写。(ENOENT 首次启动是 ok:true 的 {},不受影响。)
  it('IPC ok=false(IO 错误)→ get 抛 + grant 不写盘(不在未知态覆盖已落盘记录)', async () => {
    const mutatePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi
        .fn()
        .mockResolvedValue({ ok: false, code: 'EIO', message: 'x' }),
      mutatePluginPermissions,
    });
    const store = new IpcPermissionStore();
    await expect(store.get('p1')).rejects.toMatchObject({ code: 'EIO' });
    await expect(store.grant('p1', ['fs'])).rejects.toThrow();
    expect(mutatePluginPermissions).not.toHaveBeenCalled(); // 未知态绝不写盘
  });

  // 数据安全(复查 P2,#37 的窄缺口):readPermissions() 的 promise 自身 reject(桥/
  // 进程/通道瞬时异常,非 ok:false)时,loadingPromise 此前不被清 → 永久缓存 rejected
  // promise,后续所有 get/grant 复用它无法重试,本窗口卡死。finally 必清 → 下次可恢复。
  it('readPermissions promise reject(非 ok:false)→ get 抛,loadingPromise 清,下次能重试', async () => {
    const readPermissions = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('bridge crash'), { code: 'EPIPE' }),
      )
      .mockResolvedValue({
        ok: true,
        data: { p1: [{ permission: 'fs', granted: true, decidedAt: 2 }] },
      });
    installFakeApi({ readPermissions, mutatePluginPermissions: vi.fn() });
    const store = new IpcPermissionStore();
    await expect(store.get('p1')).rejects.toThrow(); // 桥异常 → 抛
    // loadingPromise 未卡死 → 重试读到真实数据
    expect(await store.get('p1')).toEqual([
      { permission: 'fs', granted: true, decidedAt: 2 },
    ]);
    expect(readPermissions).toHaveBeenCalledTimes(2);
  });

  it('读失败不缓存 → 恢复后下次 get 重试读到真实数据', async () => {
    const readPermissions = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'EIO', message: 'x' })
      .mockResolvedValue({
        ok: true,
        data: { p1: [{ permission: 'fs', granted: true, decidedAt: 1 }] },
      });
    installFakeApi({ readPermissions, mutatePluginPermissions: vi.fn() });
    const store = new IpcPermissionStore();
    await expect(store.get('p1')).rejects.toThrow();
    // 失败态未污染 cache/loadingPromise → 重试读到真实数据
    expect(await store.get('p1')).toEqual([
      { permission: 'fs', granted: true, decidedAt: 1 },
    ]);
    expect(readPermissions).toHaveBeenCalledTimes(2);
  });

  it('并发首次 get → 共享同一个 loadingPromise,只读一次', async () => {
    const readPermissions = vi.fn().mockResolvedValue({
      ok: true,
      data: {},
    });
    installFakeApi({ readPermissions });

    const store = new IpcPermissionStore();
    await Promise.all([store.get('a'), store.get('b'), store.get('c')]);
    expect(readPermissions).toHaveBeenCalledTimes(1);
  });
});

// 终审 P1:grant/deny/clearDenied 只发增量变更(mutatePluginPermissions),main 合并当前落盘记录并返回
// 合并结果。fakeMain 模拟 main:按权限项合并 disk 上的记录并返回合并后的记录(删除 → null)。
type FakeDecision = { permission: string; granted: boolean; decidedAt: number };
type FakeMutation =
  | { kind: 'set'; perms: readonly string[]; granted: boolean }
  | { kind: 'clear-denied' };

function fakeMain(disk: Record<string, FakeDecision[]>) {
  let now = 1000;
  const mutatePluginPermissions = vi.fn(async (id: string, m: FakeMutation) => {
    const cur = disk[id] ?? [];
    let next: FakeDecision[];
    if (m.kind === 'set') {
      next = cur.filter((d) => !m.perms.includes(d.permission));
      for (const p of m.perms) next.push({ permission: p, granted: m.granted, decidedAt: (now += 1) });
    } else {
      next = cur.filter((d) => d.granted);
    }
    if (next.length === 0) delete disk[id];
    else disk[id] = next;
    return { ok: true, data: next.length === 0 ? null : structuredClone(next) };
  });
  const readPermissions = vi.fn(async () => ({ ok: true, data: structuredClone(disk) }));
  return { readPermissions, mutatePluginPermissions };
}

describe('IpcPermissionStore.grant / deny', () => {
  it('grant / deny 空 perms 为 no-op,不读不写 IPC', async () => {
    const api = fakeMain({});
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.grant('p1', []);
    await store.deny('p1', []);

    expect(api.readPermissions).not.toHaveBeenCalled();
    expect(api.mutatePluginPermissions).not.toHaveBeenCalled();
  });

  it('grant → 只发增量 { set, perms, granted:true }(不发整条记录);cache 采用 main 合并结果', async () => {
    const api = fakeMain({
      p1: [
        { permission: 'fs', granted: false, decidedAt: 1 },
        { permission: 'shell', granted: true, decidedAt: 1 },
      ],
    });
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs', 'network']);

    expect(api.mutatePluginPermissions).toHaveBeenCalledTimes(1);
    expect(api.mutatePluginPermissions).toHaveBeenCalledWith('p1', {
      kind: 'set',
      perms: ['fs', 'network'],
      granted: true,
    });
    const byPerm = new Map((await store.get('p1')).map((d) => [d.permission, d.granted]));
    expect(byPerm).toEqual(new Map([['shell', true], ['fs', true], ['network', true]]));
  });

  it('多次 grant 同 perm → cache 不堆叠重复项', async () => {
    installFakeApi(fakeMain({}));

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs']);
    await store.grant('p1', ['fs']);

    const list = await store.get('p1');
    expect(list).toHaveLength(1);
    expect(list[0]?.granted).toBe(true);
  });

  it('deny → { set, granted:false }', async () => {
    const api = fakeMain({});
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.deny('p1', ['fs']);
    expect(api.mutatePluginPermissions).toHaveBeenCalledWith('p1', {
      kind: 'set',
      perms: ['fs'],
      granted: false,
    });
    expect(await store.get('p1')).toEqual([
      expect.objectContaining({ permission: 'fs', granted: false }),
    ]);
  });

  // 数据安全(复查 P1):写盘失败时 grant/deny 必须抛(不再只 warn)且 cache **不被
  // 半提交** —— 先写盘、成功后才提交 cache。
  it('mutatePluginPermissions ok=false → grant 抛 + cache 不被半提交(get 仍见原决策)', async () => {
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: { p1: [{ permission: 'network', granted: true, decidedAt: 1 }] },
      }),
      mutatePluginPermissions: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EIO',
        message: 'disk',
      }),
    });

    const store = new IpcPermissionStore();
    await expect(store.grant('p1', ['fs'])).rejects.toMatchObject({
      code: 'EIO',
    });
    expect(await store.get('p1')).toEqual([
      { permission: 'network', granted: true, decidedAt: 1 },
    ]);
  });
});

describe('IpcPermissionStore.clearDenied', () => {
  it('有拒绝项 → 发 { clear-denied };cache 采用 main 合并结果(保留已授项)', async () => {
    const api = fakeMain({
      p1: [
        { permission: 'fs', granted: true, decidedAt: 1 },
        { permission: 'network', granted: false, decidedAt: 2 },
      ],
    });
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');

    expect(api.mutatePluginPermissions).toHaveBeenCalledWith('p1', { kind: 'clear-denied' });
    expect(await store.get('p1')).toEqual([
      { permission: 'fs', granted: true, decidedAt: 1 },
    ]);
  });

  it('全是 denied → main 删条目(返回 null)→ cache 也删', async () => {
    const api = fakeMain({
      p1: [
        { permission: 'fs', granted: false, decidedAt: 1 },
        { permission: 'network', granted: false, decidedAt: 2 },
      ],
    });
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');
    expect(await store.get('p1')).toEqual([]);
  });

  it('没有 denied 项时 clearDenied 为 no-op,不写 IPC', async () => {
    const api = fakeMain({
      p1: [
        { permission: 'fs', granted: true, decidedAt: 1 },
        { permission: 'network', granted: true, decidedAt: 2 },
      ],
    });
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');

    expect(api.mutatePluginPermissions).not.toHaveBeenCalled();
  });

  it('pluginId 不存在 → noop,不 IPC', async () => {
    const api = fakeMain({});
    installFakeApi(api);

    const store = new IpcPermissionStore();
    await store.clearDenied('absent');
    expect(api.mutatePluginPermissions).not.toHaveBeenCalled();
  });
});

// race(R15):同一 renderer 内 grant/deny/clearDenied 并发须 per-plugin 串行,后一个变更的缓存提交不被
// 前一个迟到的提交覆盖。
describe('IpcPermissionStore · R15 并发变更串行化', () => {
  it('并发 grant(fs) + deny(shell) 同 plugin → 两决策都保留(无 lost update)', async () => {
    installFakeApi(fakeMain({}));

    const store = new IpcPermissionStore();
    await Promise.all([
      store.grant('p1', ['fs']),
      store.deny('p1', ['shell']),
    ]);

    const decisions = await store.get('p1');
    const byPerm = new Map(decisions.map((d) => [d.permission, d.granted]));
    expect(byPerm.get('fs')).toBe(true);
    expect(byPerm.get('shell')).toBe(false);
    expect(decisions).toHaveLength(2);
  });

  it('并发多次 grant 不同权限 → 全部累积', async () => {
    installFakeApi(fakeMain({}));

    const store = new IpcPermissionStore();
    await Promise.all([
      store.grant('p1', ['fs']),
      store.grant('p1', ['network']),
      store.grant('p1', ['shell']),
    ]);

    const perms = (await store.get('p1')).map((d) => d.permission).sort();
    expect(perms).toEqual(['fs', 'network', 'shell']);
  });

  // race(R101):RMW 串行链(runSerialPerKey)排空后必须删除 chains 条目,否则
  // Map 随变更过权限的不同 pluginId 单调增长 = 内存泄漏。
  it('变更链排空后回收 chains 条目(不随 pluginId 单调增长)', async () => {
    installFakeApi(fakeMain({}));

    const store = new IpcPermissionStore();
    const chains = (store as unknown as { chains: Map<string, unknown> }).chains;
    await store.grant('p1', ['fs']);
    await store.grant('p2', ['network']);
    await Promise.resolve(); // cleanup 微任务
    expect(chains.size).toBe(0);
  });
});

// 边界(E245,E215/E243 读端有界解析族):parsePermissionState 读回有界 + 字段校验,与主进程写端上限对齐。
describe('E245 parsePermissionState 有界解析 + 字段校验', () => {
  it('plugin 条目数超 10000 → 早停截断', () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < 10_050; i++) raw[`p${i}`] = [];
    const r = parsePermissionState(raw);
    expect(Object.keys(r).length).toBe(10_000);
  });

  it('单插件 decisions 超 1000 → 截断到 1000', () => {
    const decisions = Array.from({ length: 1100 }, () => ({
      permission: 'fs',
      granted: true,
      decidedAt: 1,
    }));
    const r = parsePermissionState({ 'com.p': decisions });
    expect(r['com.p']?.decisions.length).toBe(1000);
  });

  it('decidedAt 非有限(Infinity/NaN)或负 → 丢弃该 decision', () => {
    const r = parsePermissionState({
      'com.p': [
        { permission: 'fs', granted: true, decidedAt: Infinity },
        { permission: 'network', granted: true, decidedAt: NaN },
        { permission: 'shell', granted: true, decidedAt: -1 },
        { permission: 'clipboard', granted: true, decidedAt: 123 }, // 唯一合法
      ],
    });
    expect(r['com.p']?.decisions.map((d) => d.permission)).toEqual(['clipboard']);
  });

  it('超长 permission → 丢弃;记录里的 pathScopes 不进 renderer 状态(由 main 读写)', () => {
    const r = parsePermissionState({
      'com.p': {
        decisions: [{ permission: 'x'.repeat(257), granted: true, decidedAt: 1 }],
        pathScopes: [{ path: '/ok', mode: 'rw' }],
      },
    });
    expect(r['com.p']).toEqual({ decisions: [] });
  });

  it('全非法 decisions 复用稳定空数组', () => {
    const raw = {
      'com.p': {
        decisions: [{ permission: 'fs', granted: true, decidedAt: NaN }],
      },
    };
    const a = parsePermissionState(raw);
    const b = parsePermissionState(raw);

    expect(a['com.p']?.decisions).toEqual([]);
    expect(a['com.p']?.decisions).toBe(b['com.p']?.decisions);
  });

  it('合法数据原样解析(回归)', () => {
    const r = parsePermissionState({
      'com.p': [{ permission: 'fs', granted: true, decidedAt: 1700000000000 }],
    });
    expect(r['com.p']?.decisions).toEqual([
      { permission: 'fs', granted: true, decidedAt: 1700000000000 },
    ]);
  });
});
