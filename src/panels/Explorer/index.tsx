import { useWorkspaceStore } from '@/stores/workspace.store';
import { EmptyWorkspace } from './EmptyWorkspace';
import { FolderTree } from './FolderTree';

// Explorer 主容器:根据 workspaceRoot 路由空态 ↔ 文件树。
// 持久化在 src/main.tsx 的 initExplorerPersistence 启动后,
// hydrate 完成会自动触发 setRoot,这里 store hook 自然重渲染。
// Header 移入 FolderTree(便于 expand/collapse all 直接用 tree 实例)。
export function Explorer() {
  const root = useWorkspaceStore((s) => s.root);
  if (!root) return <EmptyWorkspace />;
  return <FolderTree root={root} />;
}
