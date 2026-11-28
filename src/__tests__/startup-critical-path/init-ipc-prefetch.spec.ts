// @vitest-environment jsdom
// 性能(冷启动关键路径):renderer init() 开头即并发发起 layout.read 预取与 explorer.read,不再串在
// await getLocale 之后;i18n 仍在首次渲染(createRoot)前就绪(既有契约)。
// mock 集合沿用 i18n-en-zh-ko/bootstrap-locale-sync.spec.ts(init() 牵涉整个 shell 启动)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings.store';
import { flushMacrotasks } from '../_helpers/async';

const mocks = vi.hoisted(() => {
  const rootRender = vi.fn();
  return {
    rootRender,
    createRoot: vi.fn(() => ({ render: rootRender })),
    bootCorePlugins: vi.fn(),
    startPluginMcpInvokeBridge: vi.fn(),
    coApp: {
      commands: { register: vi.fn(() => ({ dispose: vi.fn() })) },
      mcp: {},
    },
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
      onScopeRequestCancelled: vi.fn(() => () => {}),
      onScopeRequest: vi.fn(() => () => {}),
    },
    initExplorerPersistence: vi.fn(async (..._args: unknown[]) => undefined),
    startPluginFsScopeRequestBridge: vi.fn(),
    startDebugStoreSync: vi.fn(),
    startWorkspaceTrustSync: vi.fn(),
    pluginsOnPermissionsChanged: vi.fn(),
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
      onPermissionsChanged: mocks.pluginsOnPermissionsChanged,
      onEnabledChanged: vi.fn(),
      onInstalled: vi.fn(),
      onProtocolUrl: mocks.pluginsOnProtocolUrl,
    },
    pluginDataRaw: {
      onChanged: vi.fn(),
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
  startDebugStoreSync: mocks.startDebugStoreSync,
}));

// init() 启动工作区信任状态同步(订阅 coApi.workspaceTrust),同上桩掉。
vi.mock('@/stores/workspace-trust.store', () => ({
  startWorkspaceTrustSync: mocks.startWorkspaceTrustSync,
}));

vi.mock('@/plugins/permissions/usePluginFsScopeRequests', () => ({
  startPluginFsScopeRequestBridge: mocks.startPluginFsScopeRequestBridge,
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

  // perf:popout 子窗口是独立 JS 上下文(独立 BrowserWindow 加载同一 renderer 入口 ?popout=1),只渲染 PopoutHost;
  // 面板由父窗口 React 经 portal 渲染,子窗口自己的 store / 插件实例无任何 UI 使用。init 只保留渲染所需
  // (lmApi 捕获 / i18n / createRoot(App)),不再跑 explorer 持久化、插件扫描+onload、MCP / fs-scope / debug / 协议桥。
  // 安全:弹出的插件面板 portal 进 popout 的 DOM,插件可经 el.ownerDocument.defaultView 取 popout 窗口的原生
  // fetch / navigator.clipboard,绕过 app.network / app.clipboard 权限门 → popout 也须在 PROD 下 sandboxSweep。
  it('popout 子窗口在 PROD 下同样执行 sandboxSweep(与主窗口清洗口径一致)', async () => {
    mocks.i18nGetLocale.mockResolvedValue({ ok: true, data: 'zh' });
    vi.stubEnv('PROD', true);
    try {
      const init = await loadInit();
      mocks.popout.value = true;
      await init();
      expect(mocks.sandboxSweep).toHaveBeenCalledTimes(1);
      expect(mocks.bootCorePlugins).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('popout 子窗口 → 只做 i18n + 渲染,跳过持久化 / 插件 / 各类桥;主窗口照常', async () => {
    mocks.i18nGetLocale.mockResolvedValue({ ok: true, data: 'zh' });
    const init = await loadInit();

    mocks.popout.value = true;
    await init();
    await flushMacrotasks(5);
    expect(mocks.captureLmApi).toHaveBeenCalledTimes(1);
    expect(mocks.i18nGetLocale).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().locale).toBe('zh');
    expect(mocks.createRoot).toHaveBeenCalledTimes(1);
    expect(mocks.explorerRead).not.toHaveBeenCalled();
    expect(mocks.initExplorerPersistence).not.toHaveBeenCalled();
    expect(mocks.bootCorePlugins).not.toHaveBeenCalled();
    expect(mocks.setUserPluginManager).not.toHaveBeenCalled();
    expect(mocks.setUserPermissionStore).not.toHaveBeenCalled();
    expect(mocks.pluginsOnChanged).not.toHaveBeenCalled();
    expect(mocks.pluginsOnPermissionsChanged).not.toHaveBeenCalled();
    expect(mocks.pluginsOnProtocolUrl).not.toHaveBeenCalled();
    expect(mocks.startPluginMcpInvokeBridge).not.toHaveBeenCalled();
    expect(mocks.startPluginFsScopeRequestBridge).not.toHaveBeenCalled();
    expect(mocks.startDebugStoreSync).not.toHaveBeenCalled();
    expect(mocks.startWorkspaceTrustSync).not.toHaveBeenCalled();
    expect(mocks.updateRefresh).not.toHaveBeenCalled();

    mocks.popout.value = false;
    await init();
    await flushMacrotasks(5);
    expect(mocks.explorerRead).toHaveBeenCalledTimes(1);
    expect(mocks.initExplorerPersistence).toHaveBeenCalledTimes(1);
    expect(mocks.bootCorePlugins).toHaveBeenCalledTimes(1);
    expect(mocks.setUserPluginManager).toHaveBeenCalledTimes(1);
    const mgr = mocks.setUserPluginManager.mock.calls[0]![0] as {
      init: ReturnType<typeof vi.fn>;
    };
    expect(mgr.init).toHaveBeenCalledTimes(1);
    expect(mocks.pluginsOnChanged).toHaveBeenCalledTimes(1);
    expect(mocks.pluginsOnProtocolUrl).toHaveBeenCalledTimes(1);
    expect(mocks.startPluginMcpInvokeBridge).toHaveBeenCalledTimes(1);
    expect(mocks.startPluginFsScopeRequestBridge).toHaveBeenCalledTimes(1);
    expect(mocks.startDebugStoreSync).toHaveBeenCalledTimes(1);
    expect(mocks.startWorkspaceTrustSync).toHaveBeenCalledTimes(1);
    expect(mocks.updateRefresh).toHaveBeenCalledTimes(1);
  });
});
