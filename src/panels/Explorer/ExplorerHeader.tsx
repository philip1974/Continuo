import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { IconButton, MenuItem } from '@/design';

// FolderTree 顶部固定 Header:左侧 workspace 名 + 右侧 ⋯ 溢出菜单
//(展开 / 折叠 / 切换 / 关闭)。
// VSCode 风:打开新文件夹会替换当前 root;关闭回到 EmptyWorkspace。

interface ExplorerHeaderProps {
  root: string;
  onExpandAll?: () => void;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点 wrap 外:关菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [menuOpen]);

  const switchFolder = async () => {
    if (busy) return;
    setMenuOpen(false);
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
      <div ref={wrapRef} className="relative">
        <IconButton
          size="xs"
          onClick={() => setMenuOpen((v) => !v)}
          title="更多操作"
          aria-label="更多操作"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
            <circle cx="8" cy="8" r="1.1" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
          </svg>
        </IconButton>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/40"
          >
            <MenuItem
              disabled={!onExpandAll}
              onClick={() => {
                setMenuOpen(false);
                onExpandAll?.();
              }}
            >
              展开全部
            </MenuItem>
            <MenuItem
              disabled={!onCollapseAll}
              onClick={() => {
                setMenuOpen(false);
                onCollapseAll?.();
              }}
            >
              折叠全部
            </MenuItem>
            <MenuItem disabled={busy} onClick={switchFolder}>
              切换文件夹…
            </MenuItem>
            <MenuItem
              variant="danger"
              onClick={() => {
                setMenuOpen(false);
                setRoot(null);
              }}
            >
              关闭文件夹
            </MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}
