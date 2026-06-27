// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import {
  IpcPermissionStore,
  parsePermissionState,
  serializePermissionState,
  type PermissionState,
} from '../../plugins/permissions/IpcPermissionStore';
import type { PermissionKey } from '../../plugins/permissions';

interface FakePerm {
  readPermissions: ReturnType<typeof vi.fn>;
  writePermissions?: ReturnType<typeof vi.fn>;
  writePluginPermissions?: ReturnType<typeof vi.fn>;
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
    installFakeApi({
      readPermissions,
      writePermissions: vi.fn(),
    });

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

  // 数据安全(codex 复查 P1,main #20 的 renderer 对偶):读权限失败(EACCES/EIO 经 main
  // safeHandle → ok:false)= 当前权限态未知。绝不缓存空表 —— 否则 grant/deny/clearDenied
  // 基于 {} 做 RMW,用部分 record 覆盖该 plugin 已落盘的 decisions/pathScopes。ensureLoaded
  // 抛 → 调用侧 fail-closed 不在未知态写。(ENOENT 首次启动是 ok:true 的 {},不受影响。)
  it('IPC ok=false(IO 错误)→ get 抛 + grant 不写盘(不在未知态覆盖已落盘记录)', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi
        .fn()
        .mockResolvedValue({ ok: false, code: 'EIO', message: 'x' }),
      writePluginPermissions,
    });
    const store = new IpcPermissionStore();
    await expect(store.get('p1')).rejects.toMatchObject({ code: 'EIO' });
    await expect(store.grant('p1', ['fs'])).rejects.toThrow();
    expect(writePluginPermissions).not.toHaveBeenCalled(); // 未知态绝不写盘
  });

  // 数据安全(codex 复查 P2,#37 的窄缺口):readPermissions() 的 promise 自身 reject(桥/
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
    installFakeApi({ readPermissions, writePluginPermissions: vi.fn() });
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
    installFakeApi({ readPermissions, writePluginPermissions: vi.fn() });
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
    installFakeApi({ readPermissions, writePermissions: vi.fn() });

    const store = new IpcPermissionStore();
    await Promise.all([store.get('a'), store.get('b'), store.get('c')]);
    expect(readPermissions).toHaveBeenCalledTimes(1);
  });
});

describe('IpcPermissionStore.grant / deny', () => {
  it('grant / deny 空 perms 为 no-op,不读不写 IPC', async () => {
    const readPermissions = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({ readPermissions, writePluginPermissions });

    const store = new IpcPermissionStore();
    await store.grant('p1', []);
    await store.deny('p1', []);

    expect(readPermissions).not.toHaveBeenCalled();
    expect(writePluginPermissions).not.toHaveBeenCalled();
  });

  // 数据安全:store 改走 writePluginPermissions(单 plugin 合并写),
  // 不再整表写回(整表写在多窗口下会用陈旧快照覆盖别窗口的决策)。
  it('grant 新 perm → 单 plugin 写盘 + cache 反映;反向决策被替换', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          'p1': [{ permission: 'fs', granted: false, decidedAt: 1 }],
        },
      }),
      writePluginPermissions,
    });

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs', 'network']);

    expect(writePluginPermissions).toHaveBeenCalledTimes(1);
    const [id, record] = writePluginPermissions.mock.calls[0]! as [
      string,
      { permission: string; granted: boolean }[],
    ];
    expect(id).toBe('p1');
    expect(record.find((d) => d.permission === 'fs')!.granted).toBe(true);
    expect(record.find((d) => d.permission === 'network')!.granted).toBe(true);
    expect(record).toHaveLength(2);
  });

  it('多次 grant 同 perm → cache 不堆叠重复项', async () => {
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePluginPermissions: vi.fn().mockResolvedValue({ ok: true }),
    });

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs']);
    await store.grant('p1', ['fs']);

    const list = await store.get('p1');
    expect(list).toHaveLength(1);
    expect(list[0]?.granted).toBe(true);
  });

  it('deny 写 granted=false', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePluginPermissions,
    });

    const store = new IpcPermissionStore();
    await store.deny('p1', ['fs']);
    const [id, record] = writePluginPermissions.mock.calls[0]! as [
      string,
      { permission: string; granted: boolean }[],
    ];
    expect(id).toBe('p1');
    expect(record).toEqual([
      expect.objectContaining({ permission: 'fs', granted: false }),
    ]);
  });

  it('批量覆盖权限 → 不对传入 perms 逐条 includes 扫描旧决策', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          p1: [
            { permission: 'fs', granted: false, decidedAt: 1 },
            { permission: 'network', granted: true, decidedAt: 2 },
            { permission: 'shell', granted: true, decidedAt: 3 },
            { permission: 'clipboard', granted: true, decidedAt: 4 },
          ],
        },
      }),
      writePluginPermissions,
    });
    const perms: readonly PermissionKey[] = ['fs', 'network'];
    const includesSpy = vi.spyOn(Array.prototype, 'includes');
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      const store = new IpcPermissionStore();
      await store.deny('p1', perms);
      const filterCallsDuringDeny = filterSpy.mock.calls.length;
      let callsOnInputPerms = 0;
      for (const ctx of includesSpy.mock.contexts) {
        if (ctx === perms) callsOnInputPerms++;
      }
      const [, record] = writePluginPermissions.mock.calls[0]! as [
        string,
        { permission: string; granted: boolean }[],
      ];

      expect(callsOnInputPerms).toBe(0);
      expect(filterCallsDuringDeny).toBe(0);
      expect(record).toMatchObject([
        { permission: 'shell', granted: true },
        { permission: 'clipboard', granted: true },
        { permission: 'fs', granted: false },
        { permission: 'network', granted: false },
      ]);
    } finally {
      includesSpy.mockRestore();
      filterSpy.mockRestore();
    }
  });

  // 数据安全(codex 复查 P1):写盘失败时 grant/deny 必须抛(不再只 warn)且 cache **不被
  // 半提交** —— 先写盘、成功后才提交 cache。否则写失败时 cache 进入未落盘半提交态,下次
  // 成功写会把这次失败的变更一起持久化、覆盖磁盘原有决策,且调用方误以为已保存。
  it('writePluginPermissions ok=false → grant 抛 + cache 不被半提交(get 仍见原决策)', async () => {
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: { p1: [{ permission: 'network', granted: true, decidedAt: 1 }] },
      }),
      writePluginPermissions: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EIO',
        message: 'disk',
      }),
    });

    const store = new IpcPermissionStore();
    await expect(store.grant('p1', ['fs'])).rejects.toMatchObject({
      code: 'EIO',
    });
    // cache 未被半提交:仍只见写盘前的 network 决策,没有失败的 fs(否则下次成功写会带上它)
    expect(await store.get('p1')).toEqual([
      { permission: 'network', granted: true, decidedAt: 1 },
    ]);
  });
});

describe('IpcPermissionStore.clearDenied', () => {
  it('删 granted=false 项,保留 granted=true(单 plugin 写)', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          'p1': [
            { permission: 'fs', granted: true, decidedAt: 1 },
            { permission: 'network', granted: false, decidedAt: 2 },
          ],
        },
      }),
      writePluginPermissions,
    });

    const store = new IpcPermissionStore();
    const filterSpy = vi.spyOn(Array.prototype, 'filter');
    await store.clearDenied('p1');
    const filterCallsDuringClear = filterSpy.mock.calls.length;
    filterSpy.mockRestore();

    const [id, record] = writePluginPermissions.mock.calls[0]! as [
      string,
      { permission: string; granted: boolean }[],
    ];
    expect(id).toBe('p1');
    expect(filterCallsDuringClear).toBe(0);
    expect(record).toEqual([
      expect.objectContaining({ permission: 'fs', granted: true }),
    ]);
  });

  it('全是 denied → 写空记录(main 据此删 entry)', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          'p1': [
            { permission: 'fs', granted: false, decidedAt: 1 },
            { permission: 'network', granted: false, decidedAt: 2 },
          ],
        },
      }),
      writePluginPermissions,
    });

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');

    const [id, record] = writePluginPermissions.mock.calls[0]! as [
      string,
      unknown[],
    ];
    expect(id).toBe('p1');
    expect(record).toEqual([]); // 空记录 → 删除 entry
  });

  it('没有 denied 项时 clearDenied 为 no-op,不写 IPC', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          p1: [
            { permission: 'fs', granted: true, decidedAt: 1 },
            { permission: 'network', granted: true, decidedAt: 2 },
          ],
        },
      }),
      writePluginPermissions,
    });

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');

    expect(writePluginPermissions).not.toHaveBeenCalled();
  });

  it('pluginId 不存在 → noop,不 IPC', async () => {
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePluginPermissions,
    });

    const store = new IpcPermissionStore();
    await store.clearDenied('absent');
    expect(writePluginPermissions).not.toHaveBeenCalled();
  });
});

// race(R15):同一 renderer 内 grant/deny/clearDenied 并发须 per-plugin 串行,避免各从同一
// cache 快照算整条 record 覆盖写而 lost update(main 按 plugin 整条覆盖、不合并 decisions)。
describe('IpcPermissionStore · R15 并发变更串行化', () => {
  it('并发 grant(fs) + deny(shell) 同 plugin → 两决策都保留(无 lost update)', async () => {
    const readPermissions = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({ readPermissions, writePluginPermissions });

    const store = new IpcPermissionStore();
    // 并发触发(不在中间 await)
    await Promise.all([
      store.grant('p1', ['fs']),
      store.deny('p1', ['shell']),
    ]);

    const decisions = await store.get('p1');
    const byPerm = new Map(decisions.map((d) => [d.permission, d.granted]));
    expect(byPerm.get('fs')).toBe(true); // grant 未被 deny 覆盖
    expect(byPerm.get('shell')).toBe(false); // deny 未被 grant 覆盖
    expect(decisions).toHaveLength(2);
  });

  it('并发多次 grant 不同权限 → 全部累积(串行 RMW 读到前一个已提交 cache)', async () => {
    const readPermissions = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({ readPermissions, writePluginPermissions });

    const store = new IpcPermissionStore();
    await Promise.all([
      store.grant('p1', ['fs']),
      store.grant('p1', ['network']),
      store.grant('p1', ['shell']),
    ]);

    const perms = (await store.get('p1')).map((d) => d.permission).sort();
    expect(perms).toEqual(['fs', 'network', 'shell']);
  });

  // race(R101):RMW 串行链(runExclusive→runSerialPerKey)排空后必须删除 chains 条目,否则
  // Map 随变更过权限的不同 pluginId 单调增长 = 内存泄漏。
  it('变更链排空后回收 chains 条目(不随 pluginId 单调增长)', async () => {
    const readPermissions = vi.fn().mockResolvedValue({ ok: true, data: {} });
    const writePluginPermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({ readPermissions, writePluginPermissions });

    const store = new IpcPermissionStore();
    const chains = (store as unknown as { chains: Map<string, unknown> }).chains;
    await store.grant('p1', ['fs']);
    await store.grant('p2', ['network']);
    await Promise.resolve(); // cleanup 微任务
    expect(chains.size).toBe(0); // 两 pluginId 链排空后全回收
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

  it('超长 permission / path → 丢弃', () => {
    const r = parsePermissionState({
      'com.p': {
        decisions: [{ permission: 'x'.repeat(257), granted: true, decidedAt: 1 }],
        pathScopes: [
          { path: 'y'.repeat(8193), mode: 'r' },
          { path: '/ok', mode: 'rw' }, // 唯一合法
        ],
      },
    });
    expect(r['com.p']?.decisions).toEqual([]);
    expect(r['com.p']?.pathScopes).toEqual([{ path: '/ok', mode: 'rw' }]);
  });

  it('全非法 decisions / pathScopes 复用稳定空数组', () => {
    const raw = {
      'com.p': {
        decisions: [{ permission: 'fs', granted: true, decidedAt: NaN }],
        pathScopes: [{ path: '/bad', mode: 'write' }],
      },
    };
    const a = parsePermissionState(raw);
    const b = parsePermissionState(raw);

    expect(a['com.p']?.decisions).toEqual([]);
    expect(a['com.p']?.pathScopes).toEqual([]);
    expect(a['com.p']?.decisions).toBe(b['com.p']?.decisions);
    expect(a['com.p']?.pathScopes).toBe(b['com.p']?.pathScopes);
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

describe('serializePermissionState', () => {
  it('不对 state 调 Object.entries 全量物化', () => {
    const state: PermissionState = {
      'com.a': {
        decisions: [{ permission: 'fs', granted: true, decidedAt: 1 }],
      },
      'com.b': {
        decisions: [{ permission: 'network', granted: false, decidedAt: 2 }],
      },
    };
    const entriesSpy = vi.spyOn(Object, 'entries');

    try {
      const serialized = serializePermissionState(state);
      const entriesCallsOnState = entriesSpy.mock.calls.filter(
        ([arg]) => arg === state,
      ).length;

      expect(entriesCallsOnState).toBe(0);
      expect(serialized).toEqual({
        'com.a': [{ permission: 'fs', granted: true, decidedAt: 1 }],
        'com.b': [{ permission: 'network', granted: false, decidedAt: 2 }],
      });
    } finally {
      entriesSpy.mockRestore();
    }
  });
});
