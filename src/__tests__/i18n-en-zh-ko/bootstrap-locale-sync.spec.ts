// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';
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
    explorerWrite: vi.fn(),
    fsReadFile: vi.fn(),
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
      onProtocolUrl: mocks.pluginsOnProtocolUrl,
    },
    explorer: {
      read: mocks.explorerRead,
      write: mocks.explorerWrite,
    },
    fs: {
      readFile: mocks.fsReadFile,
    },
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

vi.mock('@/marketplace/reviews-store', () => ({
  useReviewsStore: {
    getState: () => ({ refresh: mocks.reviewsRefresh }),
  },
}));

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  useSettingsStore.setState({ locale: 'en', currentGen: 0 });
  mocks.i18nGetLocale.mockResolvedValue({ ok: true, data: 'zh' });
  vi.clearAllMocks();
});

describe('renderer bootstrap locale sync — P0-2', () => {
  it('main.tsx async IIFE 完成后 locale 同步到 settings.store 与 translate 模块', async () => {
    await import('@/main');

    await vi.waitFor(() => {
      expect(mocks.bootCorePlugins).toHaveBeenCalledTimes(1);
    });

    expect(mocks.captureLmApi).toHaveBeenCalledTimes(1);
    expect(mocks.i18nGetLocale).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().locale).toBe('zh');
    expect(getLocale()).toBe('zh');
    expect(mocks.createRoot).toHaveBeenCalledWith(
      document.getElementById('root'),
    );
    expect(mocks.rootRender).toHaveBeenCalledTimes(1);
  });
});
