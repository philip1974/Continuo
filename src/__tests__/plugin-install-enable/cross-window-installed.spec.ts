// @vitest-environment jsdom
// 跨窗口安装:一个主窗全新安装插件后,其它主窗立即在插件列表 / 市场里显示为已安装(对齐 VSCode),不必重启。
// main 安装成功后向**其它**窗口广播 plugins:installed { id };收到的窗口 adoptInstalled(id, { prompt: false }):
// 登记进列表,不需授权弹窗即可激活的照常激活;需要弹窗的(授权尚未决定)只登记、不激活 —— 授权弹窗只在发起安装的窗口出现,
// 不在多窗同时弹。见同目录 README。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, raw: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  windows: [] as unknown[],
  install: { current: null as null | (() => Promise<unknown>) },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/continuo-test-user-data', getVersion: () => '0.2.15' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

vi.mock('../../../electron/main/services/plugins.service', () => ({
  createPluginsWatcher: () => ({ start: () => {}, stop: () => {} }),
  installFromGit: () => h.install.current!(),
  listPluginDirs: async () => [],
  recoverInterruptedInstalls: async () => undefined,
  readEnabledIds: async () => [],
  readPermissions: async () => ({}),
  setEnabledId: async () => undefined,
  uninstallPlugin: async () => undefined,
  mutatePluginPermissions: async () => null,
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({ token: 't', generation: 1 }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

import { registerPluginsIpc } from '../../../electron/main/ipc/plugins.ipc';
import { PLUGINS_CHANNELS } from '../../../electron/shared/plugins-channels';
import { setTrustedDevOrigin } from '../../../electron/main/safe-handle';
import { makeFakeWin, type FakeWin } from '../_helpers/fake-window';
import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost, type PluginDirInfo } from '../../plugins/PluginManager';
import { wirePluginEvents, type PluginEventSources } from '../../plugins/plugin-events';
import { createTestCoApp } from '../../plugins/test-utils';
import { InMemoryPermissionStore } from '../../plugins/testing/in-memory-stores';
import type { PermissionKey } from '../../plugins/permissions';

const RENDERER_URL = 'http://localhost:5173';

describe('main:安装成功后向其它窗口广播 plugins:installed', () => {
  beforeEach(() => {
    setTrustedDevOrigin(RENDERER_URL);
    h.handlers.clear();
    h.windows.length = 0;
    registerPluginsIpc();
  });

  function install(sender: FakeWin): Promise<unknown> {
    return h.handlers.get(PLUGINS_CHANNELS.INSTALL_FROM_GIT)!(
      { senderFrame: { url: `${RENDERER_URL}/` }, sender: sender.webContents },
      { url: 'https://github.com/me/p.git' },
    );
  }

  const installedSends = (win: FakeWin): unknown[] =>
    win.webContents.send.mock.calls.filter((c) => c[0] === PLUGINS_CHANNELS.INSTALLED).map((c) => c[1]);

  it('只发给其它存活窗口(发起窗口自己已 adopt,不重复);跳过已销毁窗口', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    const c = makeFakeWin();
    const dead = makeFakeWin({ destroyed: true });
    h.windows.push(a, b, dead, c);
    h.install.current = async () => ({ id: 'com.x.p', name: 'P', version: '1.0.0' });

    await expect(install(a)).resolves.toMatchObject({ ok: true });

    expect(installedSends(a)).toEqual([]);
    expect(installedSends(b)).toEqual([{ id: 'com.x.p' }]);
    expect(installedSends(c)).toEqual([{ id: 'com.x.p' }]);
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  it('安装失败 → 不广播', async () => {
    const a = makeFakeWin();
    const b = makeFakeWin();
    h.windows.push(a, b);
    h.install.current = async () => {
      throw Object.assign(new Error('nope'), { code: 'CLONE_FAILED' });
    };
    await install(a);
    expect(installedSends(b)).toEqual([]);
  });
});

// ── renderer:两个 PluginManager 模拟窗口 A(发起安装)/ B(收到广播),共享同一份「盘上」状态 ──

const app = createTestCoApp('1.0.0');

class Loaded extends Plugin {
  static loads: string[] = [];
  onload() {
    Loaded.loads.push(this.manifest.id);
  }
}

interface Disk {
  dirs: PluginDirInfo[];
  enabled: Set<string>;
}

function dir(id: string, extra: Record<string, unknown> = {}): PluginDirInfo {
  return { id, manifestText: JSON.stringify({ id, name: id, version: '0.1.0', ...extra }), moduleUrl: `mod://${id}` };
}

function windowManager(disk: Disk, store: InMemoryPermissionStore, promptFn: ManagerHost['promptFn']): PluginManager {
  return new PluginManager(app, {
    listPluginDirs: () => disk.dirs,
    readEnabledIds: () => disk.enabled,
    mutateEnabledId: (id, enabled) => {
      if (enabled) disk.enabled.add(id);
      else disk.enabled.delete(id);
    },
    importModule: async () => ({ default: Loaded }),
    permissionStore: store,
    promptFn,
  });
}

/** 把 B 窗口接到一个可手动触发的 plugins:installed 源上(其余事件源为空)。 */
function wireInstalled(mgr: PluginManager): (id: string) => void {
  let emit: (id: string) => void = () => {};
  const sources: PluginEventSources = {
    onChanged: () => {},
    onUninstalled: () => {},
    onEnabledChanged: () => {},
    onInstalled: (cb) => {
      emit = cb;
    },
  };
  wirePluginEvents(mgr, sources, (where, err) => {
    throw new Error(`${where}: ${String(err)}`);
  });
  return (id) => emit(id);
}

const statusOf = (mgr: PluginManager, id: string) => mgr.listAll().find((p) => p.id === id)?.status;

describe('renderer:收到 plugins:installed 的窗口不重启即显示已安装', () => {
  beforeEach(() => {
    Loaded.loads = [];
  });

  it('无需授权的插件 → B 列表出现并激活', async () => {
    const disk: Disk = { dirs: [], enabled: new Set() };
    const b = windowManager(disk, new InMemoryPermissionStore(), vi.fn(async () => []));
    await b.init();
    const emit = wireInstalled(b);
    const changes = vi.fn();
    b.subscribe(changes);

    disk.dirs.push(dir('x'));
    disk.enabled.add('x');
    emit('x');

    await vi.waitFor(() => expect(statusOf(b, 'x')).toBe('enabled'));
    expect(Loaded.loads).toEqual(['x']);
    expect(changes).toHaveBeenCalled();
  });

  it('需要授权且尚未决定 → B 只登记(列表 / 市场显示已安装)、不弹授权、不加载插件代码;授权只在 A 弹', async () => {
    const disk: Disk = { dirs: [], enabled: new Set() };
    const store = new InMemoryPermissionStore();
    let resolveA!: (granted: readonly PermissionKey[]) => void;
    const promptA = vi.fn(() => new Promise<readonly PermissionKey[]>((r) => (resolveA = r)));
    const promptB = vi.fn(async (): Promise<readonly PermissionKey[]> => ['network']);
    const a = windowManager(disk, store, promptA);
    const b = windowManager(disk, store, promptB);
    await Promise.all([a.init(), b.init()]);
    const emit = wireInstalled(b);

    disk.dirs.push(dir('x', { permissions: ['network'] }));
    disk.enabled.add('x');
    const adoptA = a.adoptInstalled('x'); // 发起窗口:照常弹授权(挂起中)
    emit('x');

    await vi.waitFor(() => expect(statusOf(b, 'x')).toBe('disabled'));
    expect(promptA).toHaveBeenCalledTimes(1);
    expect(promptB).not.toHaveBeenCalled();
    expect(Loaded.loads).toEqual([]);

    resolveA(['network']);
    await adoptA;
    expect(statusOf(a, 'x')).toBe('enabled');

    // B 的用户在本窗口启用 → 授权已在 A 决定,直接激活,不再弹窗
    await b.enable('x');
    expect(statusOf(b, 'x')).toBe('enabled');
    expect(promptB).not.toHaveBeenCalled();
    expect(Loaded.loads).toEqual(['x', 'x']);
  });

  it('授权已全部决定(如先前已授予)→ B 直接激活,不弹窗', async () => {
    const disk: Disk = { dirs: [], enabled: new Set() };
    const store = new InMemoryPermissionStore();
    await store.grant('x', ['network']);
    const promptB = vi.fn(async (): Promise<readonly PermissionKey[]> => []);
    const b = windowManager(disk, store, promptB);
    await b.init();
    const emit = wireInstalled(b);

    disk.dirs.push(dir('x', { permissions: ['network'] }));
    disk.enabled.add('x');
    emit('x');

    await vi.waitFor(() => expect(statusOf(b, 'x')).toBe('enabled'));
    expect(promptB).not.toHaveBeenCalled();
  });

  it('幂等:已在列表的 id 再收到广播 → 无操作(不重复激活)', async () => {
    const disk: Disk = { dirs: [dir('x')], enabled: new Set(['x']) };
    const b = windowManager(disk, new InMemoryPermissionStore(), vi.fn(async () => []));
    await b.init();
    const emit = wireInstalled(b);
    expect(Loaded.loads).toEqual(['x']);

    emit('x');
    await new Promise((r) => setTimeout(r, 0));
    expect(Loaded.loads).toEqual(['x']);
  });
});

describe('接线', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '../../..', rel), 'utf-8');

  it('preload onInstalled 订阅 plugins:installed 并经 payload 守卫(畸形 warn + drop);主窗接到 wirePluginEvents', () => {
    expect(read('electron/preload/index.ts')).toMatch(
      /onInstalled:[\s\S]*?PLUGINS_CHANNELS\.INSTALLED,\s*guardedListener\(isPluginsChangedPayload/,
    );
    expect(read('src/main-app.ts')).toMatch(/onInstalled: \(cb\) => coApi\.plugins\.onInstalled\(cb\)/);
  });
});
