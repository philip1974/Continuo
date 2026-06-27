import {
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { IconButton, MenuItem } from '@/design';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';
import { openRecentRootOrNotify } from './open-recent-root';
import {
  workspaceRootSelectionGuard,
  cancelPendingWorkspaceRootSelection,
} from '@/lib/workspace-root-guard';
import {
  trySelectDirectoryLock,
  releaseSelectDirectoryLock,
} from '@/lib/select-directory-single-flight';
import { useMenuKeyboard } from '@/lib/use-menu-keyboard';
import { basename, recentRootLabelParts } from './path-utils';
import { useT } from '@/i18n';

// FolderTree 顶部固定 Header:左侧 workspace 名 + 右侧 ⋯ 溢出菜单
//(展开 / 折叠 / 切换 / 关闭)。
// VSCode 风:打开新文件夹会替换当前 root;关闭回到 EmptyWorkspace。
//
// 菜单 portal 到 document.body + position:fixed 按 viewport 定位 — 与
// shell/dock/HeaderActions 同款修复:Dockview 祖先有 transform:translate3d
// 创建 stacking context,把 z-modal 困在 panel 子树内,菜单会被同 panel
// 内的 file tree 内容(虚拟化 transform:translateY 也创建 SC)盖住。

interface ExplorerHeaderProps {
  root: string;
  onExpandAll?: () => void;
  onCollapseAll?: () => void;
  onRefresh?: () => void;
  onNewFile?: () => void;
  onNewDir?: () => void;
}

const NEW_FILE_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5L9 1.5Z" />
    <path d="M9 1.5V6h5" />
  </svg>
);

const NEW_FOLDER_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3l1.5 1.5h5.5A1.5 1.5 0 0 1 14.5 5.5v6.5A1.5 1.5 0 0 1 13 13.5H3a1.5 1.5 0 0 1-1.5-1.5V4Z" />
  </svg>
);

const REFRESH_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
    <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
    <path d="M13 3v3h-3" />
    <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
    <path d="M3 13v-3h3" />
  </svg>
);

const COLLAPSE_ALL_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <path d="M3 4h10M3 8h6M3 12h3" />
    <path d="M11 7l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MORE_ACTIONS_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
  </svg>
);

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
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const t = useT();
  // a11y(A18):菜单打开移焦入首项 + Escape 关闭还原焦点 + 方向键漫游(共享 hook)。
  // menuRef 为 callback ref(挂到 role=menu),menuNode.current 供 pointerdown contains 判定。
  const {
    menuRef,
    menuNode,
    onKeyDown: onMenuKeyDown,
    closeAndRestore,
  } = useMenuKeyboard({
    open: menuOpen,
    triggerRef,
    onClose: () => setMenuOpen(false),
  });
  const newFileLabel = t('panels.explorer.btn.new_file');
  const newFolderLabel = t('panels.explorer.btn.new_folder');
  const refreshLabel = t('panels.explorer.btn.refresh');
  const collapseAllLabel = t('panels.explorer.btn.collapse_all');
  const moreActionsLabel = t('panels.explorer.btn.more_actions');

  // 计算菜单坐标 — 用 trigger 按钮的 viewport rect。
  // 监听 resize / scroll 重新算,避免侧边栏滚动 / 窗口缩放后菜单错位。
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) {
        setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [menuOpen]);

  // 点 trigger / menu 外:关菜单
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      const inTrigger = triggerRef.current?.contains(target) ?? false;
      const inMenu = menuNode.current?.contains(target) ?? false;
      if (!inTrigger && !inMenu) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [menuOpen, menuNode]);

  const switchFolder = async () => {
    if (busy) return;
    // race(R106,R8 同族):busy 异步,同 tick 重复触发会并发弹原生选择器。同步单飞闸门先挡。
    if (!trySelectDirectoryLock()) return;
    closeAndRestore(); // a11y(A30):关菜单并还原焦点到触发按钮(再开原生目录对话框)
    setBusy(true);
    // race(R27):全窗口共享守卫,与 drop / 打开最近 / EmptyWorkspace 打开 互相失效。
    const isLatest = workspaceRootSelectionGuard.begin();
    try {
      const r = await coApi.fs.selectDirectory();
      if (!isLatest()) return;
      // a11y(A146,A141 同族):取消(ok+无 data)是正常 no-op;但 !r.ok / reject 此前静默 →
      // 切换文件夹失败时菜单关闭、busy 退出却无 toast/live region 反馈,用户不知为何没切。
      if (r.ok && r.data) setRoot(r.data);
      else if (!r.ok)
        notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
    } catch (err) {
      if (!isLatest()) return;
      const code = (err as { code?: string })?.code ?? 'EXCEPTION';
      notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), { code });
    } finally {
      releaseSelectDirectoryLock();
      setBusy(false);
    }
  };

  return (
    <div className="group flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-panel-soft/50 px-3 text-xs">
      <span
        className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.1em] text-fg"
        title={root}
      >
        {basename(root)}
      </span>
      {/* hover Header 时浮现常用动作图标条(VSCode 同款),默认隐藏避免视觉
       *  噪音。⋯ 溢出菜单常驻,放低频项(展开全部 / 切换 / 关闭)。 */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {onNewFile && (
          <IconButton
            size="xs"
            onClick={onNewFile}
            title={newFileLabel}
            aria-label={newFileLabel}
          >
            {NEW_FILE_ICON}
          </IconButton>
        )}
        {onNewDir && (
          <IconButton
            size="xs"
            onClick={onNewDir}
            title={newFolderLabel}
            aria-label={newFolderLabel}
          >
            {NEW_FOLDER_ICON}
          </IconButton>
        )}
        {onRefresh && (
          <IconButton
            size="xs"
            onClick={onRefresh}
            title={refreshLabel}
            aria-label={refreshLabel}
          >
            {REFRESH_ICON}
          </IconButton>
        )}
        {onCollapseAll && (
          <IconButton
            size="xs"
            onClick={onCollapseAll}
            title={collapseAllLabel}
            aria-label={collapseAllLabel}
          >
            {COLLAPSE_ALL_ICON}
          </IconButton>
        )}
      </div>
      <IconButton
        ref={triggerRef}
        size="xs"
        onClick={() => setMenuOpen((v) => !v)}
        title={moreActionsLabel}
        aria-label={moreActionsLabel}
        // a11y(A6):菜单触发按钮须告知 AT 它会弹 role=menu 弹层及当前展开态,否则只读
        // 「更多操作 button」不知可展开。
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {MORE_ACTIONS_ICON}
      </IconButton>
      {menuOpen && anchor &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
            className="z-modal min-w-[140px] overflow-hidden rounded-md border border-line bg-panel py-1 shadow-lg shadow-black/40"
          >
            <MenuItem
              disabled={!onExpandAll}
              onClick={() => {
                closeAndRestore(); // a11y(A30):激活后还原焦点到触发按钮
                onExpandAll?.();
              }}
            >
              {t('panels.explorer.menu.expand_all')}
            </MenuItem>
            {(() => {
              const recentItems = new Array<ReactElement>(recentRoots.length);
              let recentItemCount = 0;
              for (const p of recentRoots) {
                if (p === root) continue;
                const { name } = recentRootLabelParts(p);
                recentItems[recentItemCount++] = (
                  <MenuItem
                    key={p}
                    title={p}
                    // a11y(A78):菜单项只显视觉 basename,同名目录无法区分 → aria-label 注入完整路径。
                    ariaLabel={t('panels.explorer.menu.open_recent_item_aria', {
                      path: p,
                    })}
                    onClick={() => {
                      closeAndRestore(); // a11y(A30):激活后还原焦点到触发按钮
                      void openRecentRootOrNotify(p, setRoot);
                    }}
                  >
                    <span className="truncate">{name}</span>
                  </MenuItem>
                );
              }
              if (recentItemCount === 0) return null;
              recentItems.length = recentItemCount;
              return (
                <>
                  {/* a11y(A113):role=menu 内的视觉分隔线须 role="separator"(合法 menu 子结构),
                      否则 AT 把装饰 div 当异常菜单内容。 */}
                  <div role="separator" className="my-1 h-px bg-line" />
                  {/* a11y(A113):最近项用 role="group" + aria-label 成组(组名经 aria-label 提供),
                      视觉标题 aria-hidden(纯视觉,避免与组名重复朗读)。 */}
                  <div role="group" aria-label={t('panels.explorer.menu.open_recent')}>
                    <div
                      aria-hidden="true"
                      className="px-2 pb-0.5 text-2xs uppercase tracking-wider text-fg-dim"
                    >
                      {t('panels.explorer.menu.open_recent')}
                    </div>
                    {recentItems}
                  </div>
                  <div role="separator" className="my-1 h-px bg-line" />
                </>
              );
            })()}
            <MenuItem disabled={busy} onClick={switchFolder}>
              {t('panels.explorer.menu.switch_folder')}
            </MenuItem>
            <MenuItem
              variant="danger"
              onClick={() => {
                // a11y(A30):关菜单 + 还原焦点(关闭文件夹会卸载本组件,triggerRef 已空 → focus no-op)
                closeAndRestore();
                // race(R28):关闭文件夹是同步 root 变更,须先作废所有在途异步 root 选择,否则
                // 迟到的 open/drop/recent resolve 仍会 setRoot(oldPath) 撤销关闭、持久化写错 root。
                cancelPendingWorkspaceRootSelection();
                setRoot(null);
              }}
            >
              {t('panels.explorer.menu.close_folder')}
            </MenuItem>
          </div>,
          document.body,
        )}
    </div>
  );
}
