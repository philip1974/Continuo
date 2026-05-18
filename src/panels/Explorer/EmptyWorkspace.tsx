import { useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { Button, MenuItem } from '@/design';
import { coApi } from '@/lib/co-api';
import { useT } from '@/i18n';

// 未选 workspace 时占位:中央"打开文件夹"按钮(VSCode 风)。
// 调 fs.selectDirectory(原生对话框)→ setRoot,store 一变 Explorer 容器自动切到 FolderTree。
export function EmptyWorkspace() {
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  const recentRoots = useWorkspaceStore((s) => s.recentRoots);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await coApi.fs.selectDirectory();
      if (r.ok && r.data) setRoot(r.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center text-sm text-fg-muted">
      <div className="text-xs uppercase tracking-wider text-fg-dim">
        {t('panels.explorer.empty.no_folder')}
      </div>
      <Button variant="outlined" size="md" onClick={open} disabled={busy}>
        {busy
          ? t('panels.explorer.empty.opening')
          : t('panels.explorer.empty.open_folder')}
      </Button>
      {recentRoots.length > 0 && (
        <div role="menu" className="mt-4 w-full max-w-xs text-left">
          <div className="px-3 pb-1 text-2xs uppercase tracking-wider text-fg-dim">
            {t('panels.explorer.empty.recent')}
          </div>
          {recentRoots.map((p) => {
            const m = p.match(/[^/\\]+$/);
            const name = m ? m[0] : p;
            const parent = m ? p.slice(0, p.length - m[0].length).replace(/[/\\]$/, '') : '';
            return (
              <MenuItem key={p} onClick={() => setRoot(p)} title={p}>
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="truncate font-medium">{name}</span>
                  {parent && (
                    <span className="truncate text-2xs text-fg-dim">{parent}</span>
                  )}
                </span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </div>
  );
}
