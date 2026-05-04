import { useWorkspaceStore } from '@/stores/workspace.store';
import { EmptyWorkspace } from './EmptyWorkspace';
import { ExplorerHeader } from './ExplorerHeader';
import { FolderTree } from './FolderTree';

// Explorer 主容器:根据 workspaceRoot 路由空态 ↔ 文件树。
// 持久化在 src/main.tsx 的 initExplorerPersistence 启动后,
// hydrate 完成会自动触发 setRoot,这里 store hook 自然重渲染。
export function Explorer() {
  const root = useWorkspaceStore((s) => s.root);
  if (!root) return <EmptyWorkspace />;
  return (
    <div className="flex h-full w-full flex-col">
      <ExplorerHeader root={root} />
      <div className="min-h-0 flex-1">
        <FolderTree root={root} />
      </div>
    </div>
  );
}
