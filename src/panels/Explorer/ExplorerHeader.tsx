import { useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';

// FolderTree 顶部固定 Header:显示 workspace 名 + 切换/关闭按钮。
// VSCode 风:打开新文件夹会替换当前 root(不开新窗口);关闭回到 EmptyWorkspace。

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function ExplorerHeader({ root }: { root: string }) {
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
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900/50 px-2 text-xs">
      <span
        className="flex-1 truncate font-medium uppercase tracking-wider text-neutral-300"
        title={root}
      >
        {basename(root)}
      </span>
      <button
        type="button"
        onClick={switchFolder}
        disabled={busy}
        className="rounded px-2 py-0.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
        title="切换到其他文件夹"
      >
        切换
      </button>
      <button
        type="button"
        onClick={() => setRoot(null)}
        className="rounded px-2 py-0.5 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
        title="关闭当前文件夹"
      >
        关闭
      </button>
    </div>
  );
}
