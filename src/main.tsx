import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
import { bootCorePlugins } from './core-plugins';
import './styles/tailwind.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// M-Plugin v1.7:渲染前同步注册内置插件(editor / terminal / output),
// 使 lmApp.panels 在 DockShell 首次 mount 时已含 3 个 panel 类型。
bootCorePlugins();

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
