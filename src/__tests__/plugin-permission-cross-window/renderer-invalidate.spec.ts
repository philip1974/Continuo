// @vitest-environment jsdom
// 插件授权跨窗口一致(终审 P1):两个 IpcPermissionStore 模拟窗口 A / B,共享 main 侧 _permissions.json 替身。
// main 替身按权限项合并,并在变更成功后「广播」给所有窗口(调用各 store.invalidate)。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Decision = { permission: string; granted: boolean; decidedAt: number };
type Mutation =
  | { kind: 'set'; perms: string[]; granted: boolean }
  | { kind: 'clear-denied' };

const h = vi.hoisted(() => ({
  disk: {} as Record<string, Decision[]>,
  listeners: [] as ((id: string) => void)[],
  reads: 0,
  now: 100,
  // 每次 readPermissions 取完快照后调用(模拟读取在途期间到达的失效广播)。
  onRead: null as (() => void) | null,
  shellExec: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    plugins: {
      readPermissions: async () => {
        h.reads += 1;
        const data = structuredClone(h.disk);
        await Promise.resolve();
        h.onRead?.();
        return { ok: true, data };
      },
      mutatePluginPermissions: async (id: string, mutation: Mutation) => {
        const cur = h.disk[id] ?? [];
        let next: Decision[];
        if (mutation.kind === 'set') {
          next = cur.filter((d) => !mutation.perms.includes(d.permission));
          for (const p of mutation.perms) {
            next.push({ permission: p, granted: mutation.granted, decidedAt: (h.now += 1) });
          }
        } else {
          next = cur.filter((d) => d.granted);
        }
        if (next.length === 0) delete h.disk[id];
        else h.disk[id] = next;
        for (const l of h.listeners) l(id); // main 广播 plugins:permissions-changed
        return { ok: true, data: next.length === 0 ? null : structuredClone(next) };
      },
    },
    shell: {
      exec: (...args: unknown[]) => h.shellExec(...args),
    },
  },
}));

import { IpcPermissionStore } from '../../plugins/permissions/IpcPermissionStore';
import { createScopedApp } from '../../plugins/scoped-app';
import { createTestCoApp } from '../../plugins/test-utils';

const ID = 'com.x.p';

function makeWindow(): { store: IpcPermissionStore; check: (p: 'shell' | 'network' | 'fs') => Promise<boolean> } {
  const store = new IpcPermissionStore();
  h.listeners.push(() => store.invalidate());
  const app = createScopedApp(createTestCoApp(), ID, store, 'tok', ['shell', 'network', 'fs']);
  return { store, check: (p) => app.permission.check(p) };
}

beforeEach(() => {
  h.disk = {
    [ID]: [
      { permission: 'shell', granted: true, decidedAt: 1 },
      { permission: 'fs', granted: true, decidedAt: 1 },
    ],
  };
  h.listeners = [];
  h.reads = 0;
  h.onRead = null;
  h.shellExec = vi.fn(async () => ({
    ok: true,
    data: { stdout: '', stderr: '', exitCode: 0, signal: null, timedOut: false, truncated: false },
  }));
});

describe('renderer:权限变更广播后各窗口重新加载授权', () => {
  it('窗口 A 撤销 shell → 窗口 B 的 permission.check(shell) 变 false', async () => {
    const a = makeWindow();
    const b = makeWindow();
    expect(await b.check('shell')).toBe(true); // B 已缓存
    expect(await a.check('shell')).toBe(true);

    await a.store.deny(ID, ['shell']);

    expect(await b.check('shell')).toBe(false);
    expect(await a.check('shell')).toBe(false);
    expect(await b.check('fs')).toBe(true);
  });

  it('B 随后保存其它权限 → 不把 A 的撤销覆盖回来(main 与 B 缓存都保持 shell 拒绝)', async () => {
    const a = makeWindow();
    const b = makeWindow();
    await a.check('shell');
    await b.check('shell');

    await a.store.deny(ID, ['shell']);
    await b.store.grant(ID, ['network']);

    const disk = Object.fromEntries(h.disk[ID]!.map((d) => [d.permission, d.granted]));
    expect(disk).toEqual({ shell: false, fs: true, network: true });
    expect(await b.check('shell')).toBe(false);
    expect(await b.check('network')).toBe(true);
    expect(await a.check('network')).toBe(true);
  });

  it('B 在没收到广播的情况下保存(陈旧缓存)→ 只提交改动项,main 合并后 B 缓存采用合并结果', async () => {
    const b = makeWindow();
    await b.check('shell');
    // 别的窗口绕过 B 的广播直接改盘(模拟广播尚未到达)
    h.disk[ID] = [
      { permission: 'shell', granted: false, decidedAt: 50 },
      { permission: 'fs', granted: true, decidedAt: 1 },
    ];
    h.listeners = []; // 屏蔽广播
    await b.store.grant(ID, ['network']);

    expect(h.disk[ID]!.find((d) => d.permission === 'shell')!.granted).toBe(false);
    expect(await b.check('shell')).toBe(false); // 采用 main 返回的合并记录
  });

  // 终审 P1:失效期间在途的读取拿到的是撤销前快照。此前只是不落缓存,却仍交给等待者 → ensurePerm 放行一次。
  it('invalidate 发生在加载途中 → 等待者拿到按当前代际重新读取的结果,并落缓存', async () => {
    const store = new IpcPermissionStore();
    const pending = store.get(ID); // 发起加载(读到的是变更前的快照)
    h.disk[ID] = [{ permission: 'shell', granted: false, decidedAt: 9 }];
    store.invalidate();
    expect(await pending).toEqual([{ permission: 'shell', granted: false, decidedAt: 9 }]);
    expect(h.reads).toBe(2);
    expect(await store.get(ID)).toEqual([{ permission: 'shell', granted: false, decidedAt: 9 }]);
    expect(h.reads).toBe(2);
  });

  it('授权读取在途时 shell 被撤销 → shell.exec 拒绝、不发 IPC', async () => {
    const b = makeWindow();
    const app = createScopedApp(createTestCoApp(), ID, b.store, 'tok', ['shell']);
    h.onRead = () => {
      h.onRead = null;
      // 读取已取到「shell 已授」快照、尚未返回时,别的窗口撤销 shell 并广播。
      h.disk[ID] = [{ permission: 'shell', granted: false, decidedAt: 9 }];
      for (const l of h.listeners) l(ID);
    };
    await expect(app.shell.exec('/bin/echo', ['x'])).rejects.toMatchObject({ name: 'PermissionError' });
    expect(h.shellExec).not.toHaveBeenCalled();
  });

  it('每次读取都被失效(代际始终不稳定)→ 重试有上限,读取失败,shell.exec 拒绝、不发 IPC', async () => {
    const b = makeWindow();
    const app = createScopedApp(createTestCoApp(), ID, b.store, 'tok', ['shell']);
    h.onRead = () => b.store.invalidate();
    await expect(app.shell.exec('/bin/echo', ['x'])).rejects.toThrow();
    expect(h.shellExec).not.toHaveBeenCalled();
    expect(h.reads).toBeGreaterThan(1);
    expect(h.reads).toBeLessThanOrEqual(5);
  });
});
