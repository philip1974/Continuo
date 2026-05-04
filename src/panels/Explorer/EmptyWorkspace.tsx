import { useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';

// 未选 workspace 时占位:中央"打开文件夹"按钮(VSCode 风)。
// 调 fs.selectDirectory(原生对话框)→ setRoot,store 一变 Explorer 容器自动切到 FolderTree。
export function EmptyWorkspace() {
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  const recentRoots = useWorkspaceStore((s) => s.recentRoots);
  const [busy, setBusy] = useState(false);

  const open = async () => {
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
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center text-sm text-neutral-400">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        未打开文件夹
      </div>
      <button
        type="button"
        onClick={open}
        disabled={busy}
        className="rounded bg-neutral-800 px-4 py-2 text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-50"
      >
        {busy ? '打开中…' : '打开文件夹'}
      </button>
      {recentRoots.length > 0 && (
        <div className="mt-4 w-full max-w-xs space-y-1 text-left">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">
            最近打开
          </div>
          {recentRoots.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setRoot(p)}
              className="block w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title={p}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
