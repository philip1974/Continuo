import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { IconButton, MenuItem } from '@/design';
import { coApi } from '@/lib/co-api';

// FolderTree 顶部固定 Header:左侧 workspace 名 + 右侧 ⋯ 溢出菜单
//(展开 / 折叠 / 切换 / 关闭)。
// VSCode 风:打开新文件夹会替换当前 root;关闭回到 EmptyWorkspace。

interface ExplorerHeaderProps {
  root: string;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  onRefresh?: () => void;
  onNewFile?: () => void;
  onNewDir?: () => void;
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
  onRefresh,
  onNewFile,
  onNewDir,
}: ExplorerHeaderProps) {
  const setRoot = useWorkspaceStore((s) => s.setRoot);
  const recentRoots = useWorkspaceStore((s) => s.recentRoots);
  const recentOthers = recentRoots.filter((p) => p !== root);
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
      const r = await coApi.fs.selectDirectory();
      if (r.ok && r.data) setRoot(r.data);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex h-7 shrink-0 items-center gap-0.5 border-b border-line bg-panel-soft/50 px-2 text-xs">
      <span
        className="min-w-0 flex-1 truncate font-medium uppercase tracking-wider text-fg"
        title={root}
      >
        {basename(root)}
      </span>
      {/* hover Header 时浮现常用动作图标条(VSCode 同款),默认隐藏避免视觉
       *  噪音。⋯ 溢出菜单常驻,放低频项(展开全部 / 切换 / 关闭)。 */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {onNewFile && (
          <IconButton size="xs" onClick={onNewFile} title="新建文件" aria-label="新建文件">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5L9 1.5Z" />
              <path d="M9 1.5V6h5" />
            </svg>
          </IconButton>
        )}
        {onNewDir && (
          <IconButton size="xs" onClick={onNewDir} title="新建文件夹" aria-label="新建文件夹">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5h5.5A1.5 1.5 0 0 1 14.5 5.5v6.5A1.5 1.5 0 0 1 13 13.5H3a1.5 1.5 0 0 1-1.5-1.5V4Z" />
            </svg>
          </IconButton>
        )}
        {onRefresh && (
          <IconButton size="xs" onClick={onRefresh} title="刷新资源管理器" aria-label="刷新">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
              <path d="M13 3v3h-3" />
              <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
              <path d="M3 13v-3h3" />
            </svg>
          </IconButton>
        )}
        {onCollapseAll && (
          <IconButton size="xs" onClick={onCollapseAll} title="折叠全部" aria-label="折叠全部">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M3 4h10M3 8h6M3 12h3" />
              <path d="M11 7l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconButton>
        )}
      </div>
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
            {recentOthers.length > 0 && (
              <>
                <div className="my-1 h-px bg-line" />
                <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wider text-fg-dim">
                  打开最近
                </div>
                {recentOthers.map((p) => {
                  const m = p.match(/[^/\\]+$/);
                  const name = m ? m[0] : p;
                  return (
                    <MenuItem
                      key={p}
                      title={p}
                      onClick={() => {
                        setMenuOpen(false);
                        setRoot(p);
                      }}
                    >
                      <span className="truncate">{name}</span>
                    </MenuItem>
                  );
                })}
                <div className="my-1 h-px bg-line" />
              </>
            )}
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
