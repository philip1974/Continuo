// @vitest-environment jsdom
// a11y(A126,A58 同族):fs-scope 授权决定回传链(requestFsScope → _scopeDecision)reject 时须
// notify.error,不静默丢弃(用户已点授权/拒绝、弹窗已关,失败无反馈则 main 侧 pending/超时)。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onScopeRequest: vi.fn(),
  scopeDecision: vi.fn(),
  requestFsScope: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      onScopeRequest: h.onScopeRequest,
      _scopeDecision: h.scopeDecision,
    },
  },
}));
vi.mock('@/notifications/notify', () => ({ notify: { error: h.notifyError } }));
vi.mock('../../plugins/permissions/promptStore', () => ({
  usePermissionPromptStore: {
    getState: () => ({ requestFsScope: h.requestFsScope }),
  },
}));

import {
  buildFsScopePromptScopes,
  startPluginFsScopeRequestBridge,
} from '../../plugins/permissions/usePluginFsScopeRequests';

type Handler = (p: {
  requestId: string;
  pluginId: string;
  scopes: readonly { path: string; mode: 'r' | 'rw' }[];
}) => void;

function fireRequest(): Promise<void> {
  startPluginFsScopeRequestBridge();
  const handler = h.onScopeRequest.mock.calls[0]![0] as Handler;
  handler({ requestId: 'r1', pluginId: 'p1', scopes: [{ path: '~/x', mode: 'r' }] });
  // 让 requestFsScope/_scopeDecision 的 microtask 链跑完
  return Promise.resolve();
}

beforeEach(() => {
  Object.values(h).forEach((m) => m.mockReset());
  h.onScopeRequest.mockReturnValue(() => {});
});

describe('a11y(A126) — fs-scope 决定回传失败须反馈', () => {
  it('scope prompt 列表按 scopes.length 预分配,不通过 out.push 扩容', () => {
    expect(
      buildFsScopePromptScopes([
        { path: '~/x', mode: 'r' },
        { path: '/tmp/y', mode: 'rw' },
      ]).map((scope) => scope.mode),
    ).toEqual(['r', 'rw']);
    expect(buildFsScopePromptScopes.toString()).not.toContain('out.push(');
  });

  it('_scopeDecision reject → notify.error', async () => {
    h.requestFsScope.mockResolvedValue({ granted: true });
    h.scopeDecision.mockRejectedValue(new Error('ipc down'));
    await fireRequest();
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('requestFsScope reject → notify.error', async () => {
    h.requestFsScope.mockRejectedValue(new Error('store err'));
    await fireRequest();
    await vi.waitFor(() => {
      expect(h.notifyError).toHaveBeenCalledTimes(1);
    });
  });

  it('正常决定 → _scopeDecision 调用,不报错', async () => {
    h.requestFsScope.mockResolvedValue({ granted: false });
    h.scopeDecision.mockResolvedValue(undefined);
    await fireRequest();
    await vi.waitFor(() => {
      expect(h.scopeDecision).toHaveBeenCalledWith('r1', { granted: false });
    });
    expect(h.notifyError).not.toHaveBeenCalled();
  });
});

// race(R99,R98 同型):bridge 卸载/HMR/重启后,已进入的 requestFsScope(...).then 仍是异步;旧生命周期
// 的迟到授权/拒绝若无条件 _scopeDecision,会完成已取消/已过期的 scope pending,或污染新 bridge 同
// requestId。active 守卫:unsub 置 false,_scopeDecision(及失败 toast)前复查,过期结果丢弃。
describe('race(R99) — bridge 卸载后迟到决定不回传', () => {
  it('unsub 后在途 requestFsScope 的迟到决定不调 _scopeDecision', async () => {
    let resolveScope: (v: { granted: boolean }) => void = () => {};
    h.requestFsScope.mockReturnValue(
      new Promise<{ granted: boolean }>((r) => {
        resolveScope = r;
      }),
    );
    h.scopeDecision.mockResolvedValue(undefined);
    h.onScopeRequest.mockReturnValue(() => {});

    const unsub = startPluginFsScopeRequestBridge();
    const handler = h.onScopeRequest.mock.calls[0]![0] as Handler;
    handler({ requestId: 'r1', pluginId: 'p1', scopes: [{ path: '~/x', mode: 'r' }] }); // 在途
    unsub(); // bridge 卸载(active=false)
    resolveScope({ granted: true }); // 迟到决定
    await Promise.resolve();
    await Promise.resolve();

    expect(h.scopeDecision).not.toHaveBeenCalled(); // 迟到决定不回写 main
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('unsub 后在途 requestFsScope 的迟到 reject 不弹 toast', async () => {
    let rejectScope: (e: Error) => void = () => {};
    h.requestFsScope.mockReturnValue(
      new Promise<{ granted: boolean }>((_, rej) => {
        rejectScope = rej;
      }),
    );
    h.onScopeRequest.mockReturnValue(() => {});

    const unsub = startPluginFsScopeRequestBridge();
    const handler = h.onScopeRequest.mock.calls[0]![0] as Handler;
    handler({ requestId: 'r1', pluginId: 'p1', scopes: [{ path: '~/x', mode: 'r' }] });
    unsub();
    rejectScope(new Error('store err'));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.notifyError).not.toHaveBeenCalled(); // 迟到失败不弹过期 toast
    expect(h.scopeDecision).not.toHaveBeenCalled();
  });
});

// 边界(E169,E168 同族 IPC ingress 纵深防御):plugin-fs:scope-request payload runtime 守卫。
// 畸形 payload → drop + warn,不进 prompt store(requestFsScope 不调用)、不抛(scopes.map/scope.path)。
describe('E169 — scope-request payload runtime 校验', () => {
  it('prompt scopes 构造单趟扫描,不调用 scopes.map', () => {
    const scopes = [
      { path: '/repo/a', mode: 'r' },
      { path: '/repo/b', mode: 'rw' },
    ] as const;
    const mapSpy = vi.spyOn(scopes, 'map');

    try {
      expect(buildFsScopePromptScopes(scopes)).toEqual([
        { path: '/repo/a', mode: 'r', displayPath: '/repo/a' },
        { path: '/repo/b', mode: 'rw', displayPath: '/repo/b' },
      ]);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('畸形 payload(null/scopes 非数组/scope 缺 mode/超长 path/非法 pluginId/超长 requestId)→ drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startPluginFsScopeRequestBridge();
    const handler = h.onScopeRequest.mock.calls[0]![0] as (p: unknown) => void;
    const bad: unknown[] = [
      null,
      'a string',
      { requestId: 'r1', pluginId: 'p1', scopes: 'not-array' },
      { requestId: 'r1', pluginId: 'p1', scopes: [{ path: '~/x' }] }, // 缺 mode
      { requestId: 'r1', pluginId: 'p1', scopes: [{ path: '~/x', mode: 'x' }] }, // 非法 mode
      {
        requestId: 'r1',
        pluginId: 'p1',
        scopes: [{ path: '/'.repeat(8193), mode: 'r' }],
      }, // 超长 path
      { requestId: '', pluginId: 'p1', scopes: [{ path: '~/x', mode: 'r' }] }, // 空 requestId
      {
        requestId: 'r1',
        pluginId: 'Bad Upper',
        scopes: [{ path: '~/x', mode: 'r' }],
      }, // 非法 pluginId
    ];
    for (const p of bad) handler(p);
    expect(h.requestFsScope).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('合规 payload(mode rw / 多 scope)→ 正常进 prompt store(回归)', async () => {
    h.requestFsScope.mockResolvedValue({ granted: true });
    h.scopeDecision.mockResolvedValue(undefined);
    startPluginFsScopeRequestBridge();
    const handler = h.onScopeRequest.mock.calls[0]![0] as Handler;
    handler({
      requestId: 'r2',
      pluginId: 'com.ok',
      scopes: [
        { path: '~/a', mode: 'r' },
        { path: '~/b', mode: 'rw' },
      ],
    });
    await vi.waitFor(() => {
      expect(h.requestFsScope).toHaveBeenCalledTimes(1);
    });
  });
});
