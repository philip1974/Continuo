import { useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { IconButton } from '@/design';

// 极紧凑文本工具按钮(header 内行高 28px,Button sm 太宽会挤掉 workspace 名)。
const compactBtnCls =
  'shrink-0 rounded px-1.5 py-0.5 text-fg-muted transition hover:bg-hover hover:text-fg disabled:opacity-40';

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
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line bg-panel-soft/50 px-2 text-xs">
      <span
        className="min-w-0 flex-1 truncate font-medium uppercase tracking-wider text-fg"
        title={root}
      >
        {basename(root)}
      </span>
      <IconButton
        size="xs"
        onClick={onExpandAll}
        disabled={!onExpandAll}
        title="展开全部"
        aria-label="展开全部"
      >
        ⊕
      </IconButton>
      <IconButton
        size="xs"
        onClick={onCollapseAll}
        disabled={!onCollapseAll}
        title="折叠全部"
        aria-label="折叠全部"
      >
        ⊖
      </IconButton>
      <span className="mx-1 h-3 w-px bg-line" aria-hidden="true" />
      <button
        type="button"
        onClick={switchFolder}
        disabled={busy}
        className={compactBtnCls}
        title="切换到其他文件夹"
      >
        切换
      </button>
      <button
        type="button"
        onClick={() => setRoot(null)}
        className={compactBtnCls}
        title="关闭当前文件夹"
      >
        关闭
      </button>
    </div>
  );
}
