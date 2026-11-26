import {
  type ReactElement,
  useContext,
  useRef,
  useState,
} from 'react';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { IconButton, MenuItem } from '@/design';
import { openRecentRootOrNotify } from './open-recent-root';
import { useRecentRootMissingPrompt } from './RecentRootMissingDialog';
import { useSelectWorkspaceFolder } from './hooks/useSelectWorkspaceFolder';
import { closeWorkspaceFolder } from './explorer-commands';
import { MoreActionsIcon } from '@/lib/ui-icons';
import { DropdownMenu } from '@/lib/dropdown-menu';
import { basename, recentRootAccessibleName } from './path-utils';
import { basenameForChrome } from '@/lib/path-label';
import { useT } from '@/i18n';
import { ExplorerVisibleContext } from './visibility';
import { pathEquals } from '@/lib/path-cross';

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

const MORE_ACTIONS_ICON = <MoreActionsIcon size={12} />;

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
  const { busy, selectFolder } = useSelectWorkspaceFolder();
  // 打开最近项时目录已不存在 → 询问是否从列表删除(VSCode 同款)
  const missingPrompt = useRecentRootMissingPrompt();
  const [menuOpen, setMenuOpen] = useState(false);
  // 交互回归修复:侧栏关闭为保活隐藏(aside hidden),portal 到 body 的菜单不会随之消失 → 隐藏即
  // 关闭(render 期同步本组件 state,隐藏帧即不渲染菜单);复位 state 保证再次显示不自动重开。
  const visible = useContext(ExplorerVisibleContext);
  if (!visible && menuOpen) setMenuOpen(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const t = useT();
  const newFileLabel = t('panels.explorer.btn.new_file');
  const newFolderLabel = t('panels.explorer.btn.new_folder');
  const refreshLabel = t('panels.explorer.btn.refresh');
  const collapseAllLabel = t('panels.explorer.btn.collapse_all');
  const moreActionsLabel = t('panels.explorer.btn.more_actions');


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
      {/* 点触发按钮 / 菜单之外即关闭(缺省内部范围) */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} triggerRef={triggerRef}>
        {({ closeAndRestore }) => (
          <>
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
                if (root !== null && pathEquals(p, root)) continue;
                const name = basenameForChrome(p);
                recentItems[recentItemCount++] = (
                  <MenuItem
                    key={p}
                    title={p}
                    // a11y(A78):菜单项只显视觉 basename,同名目录无法区分 → aria-label「名称，父路径」(以可见文字开头,WCAG 2.5.3)。
                    ariaLabel={recentRootAccessibleName(p)}
                    onClick={() => {
                      closeAndRestore(); // a11y(A30):激活后还原焦点到触发按钮
                      void openRecentRootOrNotify(p, setRoot, missingPrompt.onMissing);
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
            {/* a11y(A30):拿到单飞锁后先关菜单并还原焦点到触发按钮,再开原生目录对话框。 */}
            <MenuItem disabled={busy} onClick={() => void selectFolder(closeAndRestore)}>
              {t('panels.explorer.menu.switch_folder')}
            </MenuItem>
            <MenuItem
              variant="danger"
              onClick={() => {
                // a11y(A30):关菜单 + 还原焦点(关闭文件夹会卸载本组件,triggerRef 已空 → focus no-op)
                closeAndRestore();
                closeWorkspaceFolder();
              }}
            >
              {t('panels.explorer.menu.close_folder')}
            </MenuItem>
          </>
        )}
      </DropdownMenu>
      {missingPrompt.dialog}
    </div>
  );
}
