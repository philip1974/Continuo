// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { IpcPermissionStore } from '../../plugins/permissions/IpcPermissionStore';

interface FakePerm {
  readPermissions: ReturnType<typeof vi.fn>;
  writePermissions: ReturnType<typeof vi.fn>;
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

    expect(a).toEqual([{ permission: 'fs', granted: true, decidedAt: 100 }]);
    expect(b).toEqual(a);
    expect(c).toEqual([]);
    expect(readPermissions).toHaveBeenCalledTimes(1);
  });

  it('IPC ok=false → cache 视为空,不抛', async () => {
    installFakeApi({
      readPermissions: vi
        .fn()
        .mockResolvedValue({ ok: false, code: 'EIO', message: 'x' }),
      writePermissions: vi.fn(),
    });
    const store = new IpcPermissionStore();
    expect(await store.get('p1')).toEqual([]);
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
  it('grant 新 perm → 写盘 + cache 反映;反向决策被替换', async () => {
    const writePermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          'p1': [{ permission: 'fs', granted: false, decidedAt: 1 }],
        },
      }),
      writePermissions,
    });

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs', 'network']);

    expect(writePermissions).toHaveBeenCalledTimes(1);
    const written = writePermissions.mock.calls[0]![0] as Record<
      string,
      { permission: string; granted: boolean }[]
    >;
    expect(written.p1!.find((d) => d.permission === 'fs')!.granted).toBe(true);
    expect(written.p1!.find((d) => d.permission === 'network')!.granted).toBe(true);
    expect(written.p1).toHaveLength(2);
  });

  it('多次 grant 同 perm → cache 不堆叠重复项', async () => {
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePermissions: vi.fn().mockResolvedValue({ ok: true }),
    });

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs']);
    await store.grant('p1', ['fs']);

    const list = await store.get('p1');
    expect(list).toHaveLength(1);
    expect(list[0]?.granted).toBe(true);
  });

  it('deny 写 granted=false', async () => {
    const writePermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePermissions,
    });

    const store = new IpcPermissionStore();
    await store.deny('p1', ['fs']);
    const written = writePermissions.mock.calls[0]![0] as Record<
      string,
      { permission: string; granted: boolean }[]
    >;
    expect(written.p1).toEqual([
      expect.objectContaining({ permission: 'fs', granted: false }),
    ]);
  });

  it('writePermissions ok=false → console.warn 但 in-memory 仍变更', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePermissions: vi.fn().mockResolvedValue({
        ok: false,
        code: 'EIO',
        message: 'disk',
      }),
    });

    const store = new IpcPermissionStore();
    await store.grant('p1', ['fs']);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('writePermissions failed'),
      'EIO',
      'disk',
    );
    const list = await store.get('p1');
    expect(list).toHaveLength(1);
  });
});

describe('IpcPermissionStore.clearDenied', () => {
  it('删 granted=false 项,保留 granted=true', async () => {
    const writePermissions = vi.fn().mockResolvedValue({ ok: true });
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
      writePermissions,
    });

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');

    const written = writePermissions.mock.calls[0]![0] as Record<
      string,
      { permission: string; granted: boolean }[]
    >;
    expect(written.p1).toEqual([
      expect.objectContaining({ permission: 'fs', granted: true }),
    ]);
  });

  it('全是 denied → 删整个 entry', async () => {
    const writePermissions = vi.fn().mockResolvedValue({ ok: true });
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
      writePermissions,
    });

    const store = new IpcPermissionStore();
    await store.clearDenied('p1');

    const written = writePermissions.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(written.p1).toBeUndefined();
  });

  it('pluginId 不存在 → noop,不 IPC', async () => {
    const writePermissions = vi.fn().mockResolvedValue({ ok: true });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      writePermissions,
    });

    const store = new IpcPermissionStore();
    await store.clearDenied('absent');
    expect(writePermissions).not.toHaveBeenCalled();
  });
});
