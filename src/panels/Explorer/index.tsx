import { memo } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { EmptyWorkspace } from './EmptyWorkspace';
import { FolderTree } from './FolderTree';

// Explorer 主容器:根据 workspaceRoot 路由空态 ↔ 文件树。
// 持久化在 src/main-app.ts 的 initExplorerPersistence 启动后,
// hydrate 完成会自动触发 setRoot,这里 store hook 自然重渲染。
// Header 移入 FolderTree(便于 expand/collapse all 直接用 tree 实例)。
//
// key={root}:headless-tree 的 useTree 内部状态不响应 config.rootItemId 变,
// 切换文件夹(string A → string B)时若沿用同一 FolderTree React 实例,
// tree 状态卡在旧 root。强制 key 让 root 一变就 unmount/remount。
//
// perf:memo —— Explorer 无 props、自身只订阅 root。父级 ExplorerSidebar 随侧栏开关重渲;
// 不 memo 则级联重渲 FolderTree(useTree setConfig、
// virtualizer、全部可见 FileRow 与每行 Radix ContextMenu)。
export const Explorer = memo(function Explorer() {
  const root = useWorkspaceStore((s) => s.root);
  if (!root) return <EmptyWorkspace />;
  return <FolderTree key={root} root={root} />;
});
