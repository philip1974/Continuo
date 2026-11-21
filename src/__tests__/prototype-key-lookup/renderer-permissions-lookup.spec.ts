// @vitest-environment jsdom
// renderer 权限缓存是普通对象:插件 id `constructor` 时 cache['constructor'] 命中 Object 构造函数,
// clearDenied 读 `.decisions.some` 抛错 → PluginManager 启用该插件失败。查表须只认自有属性。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetLmApiForTest, captureLmApi } from '../../lib/co-api';
import { IpcPermissionStore } from '../../plugins/permissions/IpcPermissionStore';

function installFakeApi(plugins: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', {
    value: { plugins },
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

describe('插件 id 为 Object.prototype 成员名:renderer 权限缓存', () => {
  it('id=constructor 无记录 → get 返回空、clearDenied 不抛也不发 IPC', async () => {
    const mutatePluginPermissions = vi.fn();
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      mutatePluginPermissions,
    });
    const store = new IpcPermissionStore();
    expect(await store.get('constructor')).toEqual([]);
    await expect(store.clearDenied('constructor')).resolves.toBeUndefined();
    expect(mutatePluginPermissions).not.toHaveBeenCalled();
  });

  it('id=constructor 有拒绝记录 → clearDenied 发 clear-denied 变更', async () => {
    const mutatePluginPermissions = vi.fn().mockResolvedValue({ ok: true, data: null });
    installFakeApi({
      readPermissions: vi.fn().mockResolvedValue({
        ok: true,
        data: { constructor: [{ permission: 'fs', granted: false, decidedAt: 1 }] },
      }),
      mutatePluginPermissions,
    });
    const store = new IpcPermissionStore();
    await store.clearDenied('constructor');
    expect(mutatePluginPermissions).toHaveBeenCalledWith('constructor', { kind: 'clear-denied' });
    expect(await store.get('constructor')).toEqual([]);
  });
});
