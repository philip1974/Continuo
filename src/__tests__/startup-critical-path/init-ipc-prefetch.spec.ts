// @vitest-environment jsdom
// 性能(冷启动关键路径):renderer init() 开头即并发发起 layout.read 预取与 explorer.read,不再串在
// await getLocale 之后;i18n 仍在首次渲染(createRoot)前就绪(既有契约)。
// mock 集合沿用 i18n-en-zh-ko/bootstrap-locale-sync.spec.ts(init() 牵涉整个 shell 启动)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings.store';

const mocks = vi.hoisted(() => {
  const rootRender = vi.fn();
  return {
    rootRender,
    createRoot: vi.fn(() => ({ render: rootRender })),
    bootCorePlugins: vi.fn(),
    startPluginMcpInvokeBridge: vi.fn(),
    coApp: {
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
    },
    getPluginMcpRegistry: vi.fn(() => ({})),
    setUserPluginManager: vi.fn(),
    setUserPermissionStore: vi.fn(),
    createWindowApiHost: vi.fn(() => ({})),
    permissionRequest: vi.fn(),
    sandboxSweep: vi.fn(),
    captureLmApi: vi.fn(),
    i18nGetLocale: vi.fn<() => Promise<{ ok: true; data: 'zh' }>>(),
    i18nOnChange: vi.fn(() => () => undefined),
    pluginsOnChanged: vi.fn(),
    pluginsOnProtocolUrl: vi.fn(),
    explorerRead: vi.fn(),
    layoutRead: vi.fn(),
    popout: { value: false },
    explorerWrite: vi.fn(),
    fsReadFile: vi.fn(),
    pluginFsRaw: {
      _registerPlugin: vi.fn().mockResolvedValue({
        token: 'test-token',
        generation: 1,
      }),
      _unregisterPlugin: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('mock content'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      listDir: vi.fn().mockResolvedValue([]),
      stat: vi.fn().mockResolvedValue({
        size: 0,
        mtimeMs: 0,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      }),
      lstat: vi.fn().mockResolvedValue({
        size: 0,
        mtimeMs: 0,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      }),
      realpath: vi.fn(async (p: string) => p),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
      cp: vi.fn().mockResolvedValue(undefined),
      readGitBlob: vi.fn().mockResolvedValue(new Uint8Array()),
      atomicReplaceWithinScope: vi.fn().mockResolvedValue(undefined),
      requestScope: vi.fn().mockResolvedValue('grant'),
      _scopeDecision: vi.fn().mockResolvedValue(undefined),
      onScopeRequest: vi.fn(() => () => {}),
      onScopeUpdated: vi.fn(() => () => {}),
    },
    initExplorerPersistence: vi.fn(),
    updateRefresh: vi.fn(),
    reviewsRefresh: vi.fn(),
  };
});

vi.mock('react-dom/client', () => ({
  createRoot: mocks.createRoot,
}));

vi.mock('@/shell/App', () => ({
  App: () => null,
}));

vi.mock('@/lib/persist/explorer-persist', () => ({
  initExplorerPersistence: mocks.initExplorerPersistence,
}));

vi.mock('@/core-plugins', () => ({
  bootCorePlugins: mocks.bootCorePlugins,
}));

vi.mock('@/plugins/co-app', () => ({
  coApp: mocks.coApp,
  getPluginMcpRegistry: mocks.getPluginMcpRegistry,
}));

vi.mock('@/plugins/plugin-mcp-invoke-bridge', () => ({
  startPluginMcpInvokeBridge: mocks.startPluginMcpInvokeBridge,
}));

vi.mock('@/plugins/Plugin', () => ({
  Plugin: class Plugin {},
}));

vi.mock('@/plugins/PluginManager', () => ({
  PluginManager: class PluginManager {
    init = vi.fn(async () => undefined);
    whenScanned = vi.fn(async () => undefined);
    reload = vi.fn(async () => undefined);
  },
  setUserPluginManager: mocks.setUserPluginManager,
}));

vi.mock('@/lib/plugins-host', () => ({
  createWindowApiHost: mocks.createWindowApiHost,
}));

vi.mock('@/plugins/permissions/IpcPermissionStore', () => ({
  IpcPermissionStore: class IpcPermissionStore {},
}));

vi.mock('@/plugins/permissions/co-permission-store', () => ({
  setUserPermissionStore: mocks.setUserPermissionStore,
}));

vi.mock('@/plugins/permissions/promptStore', () => ({
  usePermissionPromptStore: {
    getState: () => ({ request: mocks.permissionRequest }),
  },
}));

vi.mock('@/plugins/permissions', () => ({
  PermissionError: class PermissionError extends Error {},
}));

vi.mock('@/plugins/sandbox-sweep', () => ({
  sandboxSweep: mocks.sandboxSweep,
}));

vi.mock('@/lib/co-api', () => ({
  captureLmApi: mocks.captureLmApi,
  coApi: {
    i18n: {
      getLocale: mocks.i18nGetLocale,
      onChange: mocks.i18nOnChange,
    },
    plugins: {
      onChanged: mocks.pluginsOnChanged,
      onUninstalled: vi.fn(),
      onPermissionsChanged: vi.fn(),
      onEnabledChanged: vi.fn(),
      onProtocolUrl: mocks.pluginsOnProtocolUrl,
    },
    layout: {
      read: mocks.layoutRead,
    },
    explorer: {
      read: mocks.explorerRead,
      write: mocks.explorerWrite,
    },
    fs: {
      readFile: mocks.fsReadFile,
    },
    pluginFsRaw: mocks.pluginFsRaw,
  },
}));

vi.mock('@/plugins/protocol/handler', () => ({
  handleProtocolUrl: vi.fn(),
}));

vi.mock('@/marketplace/update-store', () => ({
  useUpdateStore: {
    getState: () => ({ refresh: mocks.updateRefresh }),
  },
}));

// init() 启动 debug 事件同步(订阅 coApi.debug);本用例只关心 locale,与其它启动桥一样桩掉。
vi.mock('@/stores/debug.store', () => ({
  startDebugStoreSync: vi.fn(),
}));

vi.mock('@/marketplace/reviews-store', () => ({
  useReviewsStore: {
    getState: () => ({ refresh: mocks.reviewsRefresh }),
  },
}));

vi.mock('@/lib/popout-mode', () => ({
  isPopoutWindow: () => mocks.popout.value,
}));

// 与 bootstrap-locale-sync 一致:动态 import(静态 import 会在 hoisted mocks 初始化前求值 main-app 依赖链)。
const loadInit = async () => (await import('@/main-app')).init;
const loadReadDockLayout = async () =>
  (await import('@/shell/dock/layout-prefetch')).readDockLayout;

type PersistApi = { read: () => Promise<unknown> };

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  useSettingsStore.setState({ locale: 'en', currentGen: 0 });
  vi.clearAllMocks();
  mocks.popout.value = false;
  mocks.layoutRead.mockResolvedValue({ ok: true, data: null });
  mocks.explorerRead.mockResolvedValue({ ok: true, data: null });
});

describe('renderer init() 启动 IPC 并发', () => {
  it('getLocale 在途时 layout.read / explorer.read 已发起;locale 就绪后才 createRoot', async () => {
    let resolveLocale!: (v: { ok: true; data: 'zh' }) => void;
    mocks.i18nGetLocale.mockReturnValue(
      new Promise((r) => {
        resolveLocale = r;
      }),
    );
    let localeAtRender: string | null = null;
    mocks.createRoot.mockImplementation(() => {
      localeAtRender = useSettingsStore.getState().locale;
      return { render: mocks.rootRender };
    });

    const init = await loadInit();
    const readDockLayout = await loadReadDockLayout();
    const done = init();
    await Promise.resolve();
    expect(mocks.layoutRead).toHaveBeenCalledTimes(1);
    expect(mocks.explorerRead).toHaveBeenCalledTimes(1);
    expect(mocks.createRoot).not.toHaveBeenCalled();
    expect(mocks.bootCorePlugins).not.toHaveBeenCalled();

    resolveLocale({ ok: true, data: 'zh' });
    await done;
    expect(mocks.createRoot).toHaveBeenCalledTimes(1);
    expect(localeAtRender).toBe('zh'); // i18n 在首次渲染前就绪
    expect(mocks.layoutRead.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.createRoot.mock.invocationCallOrder[0]!,
    );
    // explorer.read 预取由 initExplorerPersistence 的 read() 消费,不重复发 IPC
    const api = mocks.initExplorerPersistence.mock.calls[0]![0] as PersistApi;
    await expect(api.read()).resolves.toEqual({ ok: true, data: null });
    expect(mocks.explorerRead).toHaveBeenCalledTimes(1);
    // layout 预取留给 DockShell 首次 onReady
    await expect(readDockLayout()).resolves.toEqual({ ok: true, data: null });
    expect(mocks.layoutRead).toHaveBeenCalledTimes(1);
  });

  it('popout 子窗口(无 DockShell / 无 windowSeq 段)→ 不预取 layout', async () => {
    mocks.popout.value = true;
    mocks.i18nGetLocale.mockResolvedValue({ ok: true, data: 'zh' });
    const init = await loadInit();
    await init();
    expect(mocks.layoutRead).not.toHaveBeenCalled();
    expect(mocks.createRoot).toHaveBeenCalledTimes(1);
  });

  // perf:popout 只渲染 PopoutHost(无 IconSidebar 角标),每开一个 popout 拉一次 marketplace index + N 个 manifest 全是浪费。
  it('popout 子窗口 → 插件 init 照常,但不做启动更新检查;主窗口照常检查', async () => {
    mocks.i18nGetLocale.mockResolvedValue({ ok: true, data: 'zh' });
    const flush = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const init = await loadInit();

    mocks.popout.value = true;
    await init();
    await flush();
    expect(mocks.setUserPluginManager).toHaveBeenCalledTimes(1);
    const popoutMgr = mocks.setUserPluginManager.mock.calls[0]![0] as {
      init: ReturnType<typeof vi.fn>;
    };
    expect(popoutMgr.init).toHaveBeenCalledTimes(1);
    expect(mocks.updateRefresh).not.toHaveBeenCalled();

    mocks.popout.value = false;
    await init();
    await flush();
    expect(mocks.updateRefresh).toHaveBeenCalledTimes(1);
  });
});
