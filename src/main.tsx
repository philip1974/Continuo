import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/App';
import { initExplorerPersistence } from './lib/persist/explorer-persist';
import './styles/tailwind.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// 资源管理器持久化(M-Explorer Step 3 + Step 4)。
// fire-and-forget:hydrate 在毫秒级完成,store setState 触发 React 重渲染,
// EmptyWorkspace 自动切到 FolderTree。无需 splash。
void initExplorerPersistence({
  read: () => window.api.explorer.read(),
  write: (snap) => window.api.explorer.write(snap),
});

// ── 临时诊断 — 跟 Esc 不响应问题 ────────────────────────────
// 全局 capture-phase keydown logger,只 log Escape 与 Enter,避免噪音。
// 问题定位后请移除本块。
window.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    const target = e.target as HTMLElement | null;
    const active = document.activeElement as HTMLElement | null;
    // eslint-disable-next-line no-console
    console.log(
      `[KD] phase=capture key=${e.key} target=${target?.tagName ?? '?'} active=${active?.tagName ?? '?'} activeId=${active?.id || '-'} activeCls=${active?.className?.toString().slice(0, 40) || '-'} defaultPrevented=${e.defaultPrevented}`,
    );
  },
  true,
);

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
