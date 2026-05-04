import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
import { bootCorePlugins } from './core-plugins';
import { lmApp } from './plugins/lm-app';
import { PluginManager } from './plugins/PluginManager';
import { setUserPluginManager } from './plugins/lm-plugin-manager';
import { createWindowApiHost } from './lib/plugins-host';
import { IpcPermissionStore } from './plugins/permissions/IpcPermissionStore';
import { usePermissionPromptStore } from './plugins/permissions/promptStore';
import './styles/tailwind.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// M-Plugin v1.7:渲染前同步注册内置插件(editor / terminal / output),
// 使 lmApp.panels 在 DockShell 首次 mount 时已含 3 个 panel 类型。
bootCorePlugins();

// M-Plugin v4.1+v4.2:用户插件 PluginManager + 权限决策持久化。
// permissionStore 走 IPC 持久化到 userData/plugins/_permissions.json。
// promptFn 桥到 design Modal(用户首次启用插件时弹授权)。
const userPluginManager = new PluginManager(lmApp, {
  ...createWindowApiHost(),
  permissionStore: new IpcPermissionStore(),
  promptFn: (pid, perms) =>
    usePermissionPromptStore.getState().request(pid, perms),
});
setUserPluginManager(userPluginManager);
void userPluginManager.init().catch((err) => {
  console.warn('[main] user plugin manager init failed', err);
});

// M-Plugin v4.3.1:主进程 mtime watch 推 changed → 自动 reload
window.api.plugins.onChanged((id) => {
  void userPluginManager.reload(id).catch((err) => {
    console.warn(`[main] auto-reload ${id} failed`, err);
  });
});

// M-Plugin v4.4:lm:// 外部唤起 → 路由到 commands.execute
import('./plugins/protocol/handler').then(({ handleProtocolUrl }) => {
  window.api.plugins.onProtocolUrl((url) => {
    void handleProtocolUrl(url, lmApp);
  });
});

// 资源管理器持久化(M-Explorer Step 3 + Step 4)。
// fire-and-forget:hydrate 在毫秒级完成,store setState 触发 React 重渲染,
// EmptyWorkspace 自动切到 FolderTree。无需 splash。
void initExplorerPersistence({
  read: () => window.api.explorer.read(),
  write: (snap) => window.api.explorer.write(snap),
});

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
