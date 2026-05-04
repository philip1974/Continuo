import { useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';

// FolderTree 顶部固定 Header:workspace 名 + 工具按钮(展开/折叠全部) + 切换/关闭。
// VSCode 风:打开新文件夹会替换当前 root(不开新窗口);关闭回到 EmptyWorkspace。

interface ExplorerHeaderProps {
  root: string;
  /** UI-3:展开整棵树(headless-tree expandAll 异步,会触发 listDir 全量加载). */
  onExpandAll?: () => void;
  /** UI-3:折叠整棵树到 root. */
  onCollapseAll?: () => void;
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

const iconBtnCls =
  'rounded px-1.5 py-0.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40';

export function ExplorerHeader({
  root,
  onExpandAll,
  onCollapseAll,
}: ExplorerHeaderProps) {
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  const [busy, setBusy] = useState(false);

  const switchFolder = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await window.api.fs.selectDirectory();
      if (r.ok && r.data) setRoot(r.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-900/50 px-2 text-xs">
      <span
        className="min-w-0 flex-1 truncate font-medium uppercase tracking-wider text-neutral-300"
        title={root}
      >
        {basename(root)}
      </span>
      <button
        type="button"
        onClick={onExpandAll}
        disabled={!onExpandAll}
        className={iconBtnCls}
        title="展开全部"
      >
        ⊕
      </button>
      <button
        type="button"
        onClick={onCollapseAll}
        disabled={!onCollapseAll}
        className={iconBtnCls}
        title="折叠全部"
      >
        ⊖
      </button>
      <span className="mx-1 h-3 w-px bg-neutral-800" aria-hidden="true" />
      <button
        type="button"
        onClick={switchFolder}
        disabled={busy}
        className={iconBtnCls}
        title="切换到其他文件夹"
      >
        切换
      </button>
      <button
        type="button"
        onClick={() => setRoot(null)}
        className={iconBtnCls}
        title="关闭当前文件夹"
      >
        关闭
      </button>
    </div>
  );
}
