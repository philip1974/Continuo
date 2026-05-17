import React from 'react';
import * as ReactNS from 'react';
import { createRoot } from 'react-dom/client';
import { z as zodNS } from 'zod';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
import {
  parseInitialWindowSeq,
  parseInitialWorkspace,
} from './lib/initial-workspace';
import { bootCorePlugins } from './core-plugins';
import { coApp, getPluginMcpRegistry } from './plugins/co-app';
import { startPluginMcpInvokeBridge } from './plugins/plugin-mcp-invoke-bridge';
import { Plugin } from './plugins/Plugin';
import { PluginManager } from './plugins/PluginManager';
import { setUserPluginManager } from './plugins/co-plugin-manager';
import { createWindowApiHost } from './lib/plugins-host';
import { IpcPermissionStore } from './plugins/permissions/IpcPermissionStore';
import { setUserPermissionStore } from './plugins/permissions/co-permission-store';
import { usePermissionPromptStore } from './plugins/permissions/promptStore';
import { PermissionError } from './plugins/permissions';
import { sandboxSweep } from './plugins/sandbox-sweep';
import { captureLmApi, coApi } from './lib/co-api';
import { useUpdateStore } from './marketplace/update-store';
import { useReviewsStore } from './marketplace/reviews-store';
import { breadcrumb, probeCssLoaded } from './lib/diagnostics/breadcrumb';
import { startRafHeartbeat } from './lib/diagnostics/raf-heartbeat';
import { setLocale as setI18nModuleLocale } from '@/i18n';
import {
  subscribeToI18nBroadcast,
  useSettingsStore,
} from '@/stores/settings.store';
import './styles/tailwind.css';

// Phase 4.B:**最早**调,把 window.api 缓存到 module-local。
// 之后 sandboxSweep 删掉 window.api 也不影响 LM UI(走 coApi)。
captureLmApi();

// M-Plugin v4.1 SDK 暴露:user-installed plugin 通过 globalThis.co 拿到
// Plugin 基类 + React(用 Blob URL import 时无法走 ESM bare import)。
// v5 Phase 3 增 PermissionError,plugin 可 instanceof 区分权限错误与其它。
// v5 Phase 4 增 z(zod),让 plugin 写 MCP tool 的 inputSchema 时不需 bare import.
// 后续若改 Vite plugin 注入 'lm' 模块,本块可移除。
(globalThis as unknown as {
  co: {
    Plugin: typeof Plugin;
    React: typeof ReactNS;
    PermissionError: typeof PermissionError;
    z: typeof zodNS;
  };
}).co = {
  Plugin,
  React: ReactNS,
  PermissionError,
  z: zodNS,
};

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// E2E hook:Playwright 通过 page.evaluate 调 dock 操作 / store 重置。
// 仅当 preload 探测到 `__continuoE2E` 标志时挂载;非测试环境完全无效.
// preload 通过 process.env.CONTINUO_E2E 转发(主进程在 e2e 时设这个变量).
declare const window: Window & {
  __continuoE2E?: boolean;
  __continuoTest?: {
    openOrFocusPanel: (id: string, component: string, title: string) => void;
    focusPanel: (id: string) => void;
    setEditorContent: (tabId: string, content: string) => void;
    getEditorActiveTabId: () => string | null;
    setSettingValue: (id: string, value: string | number | boolean) => void;
    getSettingValue: (id: string) => unknown;
    /** 触发权限弹窗(plugin install 流程的核心交互). */
    requestPermissions: (
      pluginId: string,
      perms: readonly string[],
    ) => Promise<readonly string[]>;
    /** 命令数量(用于 e2e 验证内置命令注册数). */
    commandCount: () => number;
    /** 注册命令(测试动态命令出现).返 dispose. */
    registerCommand: (
      id: string,
      title: string,
      hotkey?: string,
    ) => () => void;
    /** 改 keybindings override(测试 hotkey 显示更新). */
    setHotkey: (commandId: string, hotkey: string) => void;
  };
};

// topic 16: 把后续 boot 流程包 async IIFE，等 locale 真值后再 bootCorePlugins/createRoot
void (async () => {
  try {
    const initial = await coApi.i18n.getLocale();
    if (initial.ok) {
      const initialLocale = initial.data;
      useSettingsStore.setState({ locale: initialLocale, currentGen: 0 });
      setI18nModuleLocale(initialLocale);
    }
  } catch (err) {
    console.warn('[i18n] bootstrap getLocale failed', err);
  }

  subscribeToI18nBroadcast();

// M-Plugin v1.7:渲染前同步注册内置插件(editor / terminal / output),
// 使 coApp.panels 在 DockShell 首次 mount 时已含 3 个 panel 类型。
bootCorePlugins();

// v5 Phase 4:Plugin → MCP bridge 反向调用路由。preload.pluginMcp.onInvoke
// 收 main 推过来的 INVOKE → 调 registry.invokeLocal → preload.replyInvoke 答 main。
// fire-and-forget,卸载在窗口关闭时由 GC 处理(订阅 unsub 会泄漏一个 listener,
// 单 renderer 生命周期级,可接受)。
startPluginMcpInvokeBridge(getPluginMcpRegistry());

// M-Plugin v5 Phase 4:plugin import 之前清掉 globalThis.fetch +
// navigator.clipboard,plugin 直接调 raw API 抛 TypeError。
// scoped-app 走 cached refs 不受影响,LM UI 不直接用这些 API。
// dev 模式保留(Vite HMR 可能依赖 raw fetch),PROD 才严格执行。
if (import.meta.env.PROD) {
  sandboxSweep();
}

// M-Plugin v4.1+v4.2:用户插件 PluginManager + 权限决策持久化。
// permissionStore 走 IPC 持久化到 userData/plugins/_permissions.json。
// promptFn 桥到 design Modal(用户首次启用插件时弹授权)。
const userPermissionStore = new IpcPermissionStore();
setUserPermissionStore(userPermissionStore);
const userPluginManager = new PluginManager(coApp, {
  ...createWindowApiHost(),
  permissionStore: userPermissionStore,
  promptFn: (pid, perms) =>
    usePermissionPromptStore.getState().request(pid, perms),
});
setUserPluginManager(userPluginManager);
void userPluginManager.init().catch((err) => {
  console.warn('[main] user plugin manager init failed', err);
});

// M-Plugin v4.3.1:主进程 mtime watch 推 changed → 自动 reload
coApi.plugins.onChanged((id) => {
  void userPluginManager.reload(id).catch((err) => {
    console.warn(`[main] auto-reload ${id} failed`, err);
  });
});

// M-Plugin v4.4:co:// 外部唤起 → 路由到 commands.execute
import('./plugins/protocol/handler').then(({ handleProtocolUrl }) => {
  coApi.plugins.onProtocolUrl((url) => {
    void handleProtocolUrl(url, coApp);
  });
});

// 资源管理器持久化(M-Explorer Step 3 + Step 4)+ Editor session 恢复(Step E5)。
// fire-and-forget:hydrate 在毫秒级完成,store setState 触发 React 重渲染,
// EmptyWorkspace 自动切到 FolderTree。无需 splash。
// 注入 coApi.fs:启动时按 explorer.json 的 editor.openFilePaths 异步读
// 文件内容,恢复上次会话的 editor tabs。BDD: editor-session-restore。
//
// 多窗口 Phase 2B:从 query string 读 ?windowSeq=N(主窗 0,新窗自增)+
// ?workspace=<path>。windowSeq 标识自己在 explorer.json windows[] 中的段,
// 各窗 hydrate / persist 自己段不互相覆盖。query workspace 仅在自己段不存在
// (全新窗口编号)时启动用。见 issue #23。
const search = typeof window !== 'undefined' ? window.location.search : '';
const initialWindowSeq = parseInitialWindowSeq(search);
const initialWorkspace = parseInitialWorkspace(search);
void initExplorerPersistence(
  {
    read: () => coApi.explorer.read(),
    write: (snap) => coApi.explorer.write(snap),
  },
  {
    fs: { readFile: (p) => coApi.fs.readFile(p) },
    windowSeq: initialWindowSeq,
    ...(initialWorkspace !== null ? { initialWorkspace } : {}),
  },
);

// Marketplace Phase 3:启动时静默拉一次更新清单(IconSidebar 角标用)。
// fire-and-forget,不阻塞 UI 渲染。失败 console.warn 不抛。
void useUpdateStore.getState().refresh();

// Reviews Phase 1:启动时静默拉一次评论(MarketplaceTab 卡片 ★ 用)。
// 同样 fire-and-forget;NO_TOKEN 时静默退出(在 fetcher 抛错被 catch)。
void useReviewsStore.getState().refresh();

// issue #33:渲染前埋点 — 黑屏 / 卡 splash 时,日志能告诉我们 coApi 是否就绪、
// 是 reload 还是冷启动、CSS 是否真的解析了。
breadcrumb({
  event: 'renderer_pre_render',
  hasCoApi: typeof (globalThis as { window?: { __lmApi?: unknown } }).window
    ?.__lmApi !== 'undefined',
  initialWindowSeq,
  initialWorkspace,
  search,
  cssLoaded: probeCssLoaded(),
});

// issue #34:运行时绘制层心跳。rAF 缺漏 = paint pipeline 挂 → 直接二分根因层。
startRafHeartbeat();

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// 启动后 idle 时预热 Terminal lazy chunk(xterm 6MB+addons),
// 让用户首次开 terminal panel 不再等下载/解析。fire-and-forget,
// 失败静默(用户还没用到时 vite chunk 偶发失败可重试)。
const prefetchTerminal = () => {
  void import('@/panels/Terminal').catch(() => {
    /* 用户真触发时 React.lazy 会再试 */
  });
};
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(prefetchTerminal, { timeout: 3000 });
} else {
  setTimeout(prefetchTerminal, 1500);
}

if (window.__continuoE2E === true) {
  void Promise.all([
    import('@/shell/dock/dock-api-ref'),
    import('@/stores/editor.store'),
    import('@/plugins/settings/values-store'),
    import('@/plugins/permissions/promptStore'),
    import('@/plugins/co-app'),
    import('@/plugins/keybindings/keybindings-store'),
  ]).then(([dock, editor, values, perm, app, kb]) => {
    window.__continuoTest = {
      openOrFocusPanel: dock.openOrFocusPanel,
      focusPanel: dock.focusPanel,
      setEditorContent: (tabId, content) =>
        editor.useEditorStore.getState().updateContent(tabId, content),
      getEditorActiveTabId: () =>
        editor.useEditorStore.getState().activeTabId,
      setSettingValue: (id, v) =>
        values.useSettingsValuesStore.getState().setValue(id, v),
      getSettingValue: (id) =>
        values.useSettingsValuesStore.getState().values[id],
      requestPermissions: (pluginId, perms) =>
        perm.usePermissionPromptStore
          .getState()
          .request(pluginId, perms as never),
      commandCount: () => app.coApp.commands.getAll().length,
      registerCommand: (id, title, hotkey) => {
        const d = app.coApp.commands.register({
          id,
          title,
          ...(hotkey ? { hotkey } : {}),
          fn: () => {},
        });
        return () => d.dispose();
      },
      setHotkey: (commandId, hotkey) =>
        kb.useKeybindingsStore.getState().setHotkey(commandId, hotkey),
    };
  });
}
})();
