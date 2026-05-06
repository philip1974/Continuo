import React from 'react';
import * as ReactNS from 'react';
import { createRoot } from 'react-dom/client';
import { z as zodNS } from 'zod';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
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

// 资源管理器持久化(M-Explorer Step 3 + Step 4)。
// fire-and-forget:hydrate 在毫秒级完成,store setState 触发 React 重渲染,
// EmptyWorkspace 自动切到 FolderTree。无需 splash。
void initExplorerPersistence({
  read: () => coApi.explorer.read(),
  write: (snap) => coApi.explorer.write(snap),
});

// Marketplace Phase 3:启动时静默拉一次更新清单(IconSidebar 角标用)。
// fire-and-forget,不阻塞 UI 渲染。失败 console.warn 不抛。
void useUpdateStore.getState().refresh();

// Reviews Phase 1:启动时静默拉一次评论(MarketplaceTab 卡片 ★ 用)。
// 同样 fire-and-forget;NO_TOKEN 时静默退出(在 fetcher 抛错被 catch)。
void useReviewsStore.getState().refresh();

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
