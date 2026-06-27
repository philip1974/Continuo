// race(R65,R63/R64 同族):plugin-fs 的 scope-updated 广播。
//
// 根因:registerPluginFsIpc 在 pathScopeRegistry.on('scope-updated') 回调里遍历
// webContents 直接 wc.send。该回调是 EventEmitter listener,grant()/revokeAll() 同步
// emit('scope-updated') 触发它。若某个 wc 在 isDestroyed() 检查后、send 前销毁,send 抛
// "Object has been destroyed" → 冒泡出 listener → 反向打断 grant/revokeAll 调用栈 →
// IPC handler 报失败,但 scope 已写内存 / token 已 revoke = 授权状态与调用方感知不一致;
// 且循环中断使后续窗口收不到 SCOPE_UPDATED。
// 修复:每个 wc.send 独立 try/catch,失败只跳过/记录,不让广播异常冒泡。

import { afterEach, describe, expect, it, vi } from 'vitest';

type FakeWc = {
  id: number;
  isDestroyed: () => boolean;
  send: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  allWebContents: [] as FakeWc[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/continuo-test-userdata' },
  webContents: {
    getAllWebContents: () => mocks.allWebContents,
    fromId: (id: number) => mocks.allWebContents.find((w) => w.id === id) ?? null,
  },
}));

function makeWc(id: number, opts: { throwOnSend?: boolean } = {}): FakeWc {
  const send = vi.fn(() => {
    if (opts.throwOnSend) throw new Error('Object has been destroyed');
  });
  return { id, isDestroyed: () => false, send };
}

afterEach(() => {
  mocks.allWebContents = [];
  vi.clearAllMocks();
});

describe('race(R65) · plugin-fs scope-updated 广播 send 抛错不打断 grant/revoke', () => {
  it('持久化 scope 复制单趟扫描,不调用 scopes.map', async () => {
    const { copyScopesForPersistence } = await import(
      '../../../electron/main/ipc/plugin-fs.ipc'
    );
    const scopes = [
      { path: '/a', mode: 'r' as const },
      { path: '/b', mode: 'rw' as const },
    ];
    const mapSpy = vi.spyOn(scopes, 'map');

    try {
      expect(copyScopesForPersistence(scopes)).toEqual(scopes);
      expect(copyScopesForPersistence(scopes)).not.toBe(scopes);
      expect(mapSpy).not.toHaveBeenCalled();
      expect(copyScopesForPersistence.toString()).not.toContain('out.push(');
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('第一个 wc.send 抛错 → emit 不抛 + 其后健康 wc 仍收到 SCOPE_UPDATED', async () => {
    const dead = makeWc(1, { throwOnSend: true });
    const healthy = makeWc(2);
    mocks.allWebContents = [dead, healthy];
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { registerPluginFsIpc } = await import(
      '../../../electron/main/ipc/plugin-fs.ipc'
    );
    const { PLUGIN_FS_CHANNELS } = await import(
      '../../../electron/shared/plugin-fs-channels'
    );
    const ipcMain = { handle: vi.fn() } as never;
    const { pathScopeRegistry } = registerPluginFsIpc({ ipcMain });

    const payload = {
      pluginId: 'p',
      scopes: [{ path: '/x', mode: 'r' as const }],
    };

    // grant/revokeAll 同步 emit('scope-updated') 触发 listener;若 listener 抛错会冒泡
    // 回 emit → 反向打断调用栈。这里直接 emit 模拟,断言不抛(grant/revoke 调用栈安全)。
    expect(() =>
      (pathScopeRegistry as unknown as { emit: (e: string, p: unknown) => boolean }).emit(
        'scope-updated',
        payload,
      ),
    ).not.toThrow();

    // 抛错窗口之后的健康窗口仍收到广播(循环未中断)。
    expect(healthy.send).toHaveBeenCalledWith(
      PLUGIN_FS_CHANNELS.SCOPE_UPDATED,
      payload,
    );
  });
});
