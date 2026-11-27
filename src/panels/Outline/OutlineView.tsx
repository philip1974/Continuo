// 侧栏「大纲」视图(对齐 VSCode outline 视图:资源管理器视图容器里文件树下方的可折叠分区)。
// - 数据:活动编辑器组的活动 tab;Markdown → 标题树(按源码文本解析,编辑时防抖重解析,同一文本走缓存);其它 → 空状态。
// - 当前节:光标(源码 / 编辑)或视口顶部(预览)所在的节;开「跟随光标」时活动行跟随它(被折叠时落在最近的可见祖先,不自动展开)。
// - 树:role=tree + aria-activedescendant(焦点在树容器上),treeitem 带 aria-level / aria-expanded / aria-selected /
//   aria-posinset / aria-setsize;键盘同搜索结果树(↑↓ / Home / End / PageUp / PageDown / ← → / Enter / 空格),虚拟化。
// - 单击:编辑器定位到该标题(焦点留在大纲);双击 / Enter:定位并把焦点交给编辑器;空格:定位不移焦点。都记进导航历史。
// - 标题栏:展开 / 折叠分区;全部折叠;「⋯」里 跟随光标、排序依据(位置 / 名称)。过滤框:模糊匹配标题文字,保留命中项的上级。
// BDD: src/__tests__/markdown-outline/

import { useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button, IconButton, Input, MenuItem } from '@/design';
import { isImeComposing } from '@/design/ime';
import { useT } from '@/i18n';
import { DropdownMenu } from '@/lib/dropdown-menu';
import { ChevronDownIcon, MoreActionsIcon } from '@/lib/ui-icons';
import { measurePageNavGeometry, pageNavTarget } from '@/lib/list-page-nav';
import { highlightMatches } from '@/plugins/picker/highlight-matches';
import { pickerRowClassName } from '@/plugins/picker/picker-row';
import { isVirtualIndexRendered } from '@/plugins/picker/use-picker-list';
import { getPopoutDocuments, subscribePopoutDocuments } from '@/shell/dock/popout-documents';
import { groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { ExplorerVisibleContext } from '@/panels/Explorer/visibility';
import { basename } from '@/panels/Explorer/path-utils';
import { isMarkdownPath } from '@/panels/Editor/editor-path-utils';
import { isImagePreviewPath } from '@/panels/Editor/editor-image';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import {
  cachedMarkdownOutline,
  markdownOutlineOf,
  type MarkdownOutline,
} from '@/panels/Editor/markdown-outline-model';
import { onMarkdownOutlineHandlesChange } from '@/panels/Editor/markdown-outline-registry';
import { currentSymbolOrdinal, resolveSymbolTarget, revealSymbol } from '@/panels/Editor/markdown-symbol-navigation';
import { buildOutlineRows, outlineKeyAction, rowIndexOfOrdinal, type OutlineRow } from './outline-model';
import { useOutlineStore } from './outline-store';

const ROW_HEIGHT = 22;
/** 编辑时重解析的防抖(切换 tab 立即解析)。 */
export const OUTLINE_REPARSE_DEBOUNCE_MS = 150;
/** 树缩进(每级)。 */
const INDENT_PX = 12;
const CHEVRON_ICON = <ChevronDownIcon size={14} />;
const MORE_ICON = <MoreActionsIcon size={12} />;
const COLLAPSE_ALL_ICON = (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
    <path d="M5.5 8h5" strokeLinecap="round" />
  </svg>
);

/** 侧栏里的大纲分区(标题栏常驻;展开时才挂载内容与监听)。 */
export function OutlineSection() {
  const t = useT();
  const expanded = useOutlineStore((s) => s.expanded);
  const bodyId = useId();
  return (
    <section
      aria-label={t('panels.outline.title')}
      data-testid="outline-view"
      className={expanded ? 'flex min-h-24 basis-2/5 flex-col border-t border-line' : 'shrink-0 border-t border-line'}
    >
      <OutlineHeader bodyId={bodyId} />
      {expanded && <OutlineBody id={bodyId} />}
    </section>
  );
}

function OutlineHeader({ bodyId }: { readonly bodyId: string }) {
  const t = useT();
  const expanded = useOutlineStore((s) => s.expanded);
  const followCursor = useOutlineStore((s) => s.followCursor);
  const sortBy = useOutlineStore((s) => s.sortBy);
  const [menuOpen, setMenuOpen] = useState(false);
  // 侧栏保活隐藏时 portal 出去的菜单不随之消失 → 隐藏即关闭(同 ExplorerHeader)
  const visible = useContext(ExplorerVisibleContext);
  if (!visible && menuOpen) setMenuOpen(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const title = t('panels.outline.title');
  const collapseAllLabel = t('panels.outline.collapse_all');
  const moreLabel = t('panels.outline.more_actions');
  return (
    <div className="group flex h-7 shrink-0 items-center gap-0.5 bg-panel-soft/50 pr-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => useOutlineStore.getState().setExpanded(!expanded)}
        className="!h-7 min-w-0 flex-1 !justify-start !gap-1 !rounded-none !border-0 !px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-fg"
      >
        <span className={`shrink-0 text-fg-muted transition-transform ${expanded ? '' : '-rotate-90'}`} aria-hidden="true">
          {CHEVRON_ICON}
        </span>
        <span className="truncate">{title}</span>
      </Button>
      {expanded && (
        <>
          <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <IconButton
              size="xs"
              title={collapseAllLabel}
              aria-label={collapseAllLabel}
              onClick={() => useOutlineStore.getState().requestCollapseAll()}
            >
              {COLLAPSE_ALL_ICON}
            </IconButton>
          </div>
          <IconButton
            ref={triggerRef}
            size="xs"
            title={moreLabel}
            aria-label={moreLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {MORE_ICON}
          </IconButton>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} triggerRef={triggerRef}>
            {({ closeAndRestore }) => (
              <>
                <MenuItem
                  checked={followCursor}
                  onClick={() => {
                    closeAndRestore();
                    useOutlineStore.getState().setFollowCursor(!followCursor);
                  }}
                >
                  {t('panels.outline.follow_cursor')}
                </MenuItem>
                <div role="separator" className="my-1 h-px bg-line" />
                <MenuItem
                  checked={sortBy === 'position'}
                  checkKind="radio"
                  onClick={() => {
                    closeAndRestore();
                    useOutlineStore.getState().setSortBy('position');
                  }}
                >
                  {t('panels.outline.sort_position')}
                </MenuItem>
                <MenuItem
                  checked={sortBy === 'name'}
                  checkKind="radio"
                  onClick={() => {
                    closeAndRestore();
                    useOutlineStore.getState().setSortBy('name');
                  }}
                >
                  {t('panels.outline.sort_name')}
                </MenuItem>
              </>
            )}
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

type OutlineData =
  | { readonly status: 'no-editor' }
  | { readonly status: 'loading'; readonly fileName: string }
  | { readonly status: 'ready'; readonly fileName: string; readonly outline: MarkdownOutline };

/** 活动编辑器组的活动 tab 的标题树(enabled = 侧栏可见;不可见时不解析)。 */
function useActiveOutline(enabled: boolean): { readonly groupId: string; readonly data: OutlineData } {
  const groupId = useEditorStore((s) => s.activeGroupId);
  const tab = useEditorStore((s) => {
    const id = groupActiveTabIdOf(s, s.activeGroupId);
    return id === null ? null : (findEditorFileTabById(s.tabs, id) ?? null);
  });
  const markdown = tab !== null && !isImagePreviewPath(tab.filePath) && isMarkdownPath(tab.filePath);
  const content = markdown ? tab.content : null;
  const tabId = markdown ? tab.id : null;
  const [parsed, setParsed] = useState<{ readonly tabId: string; readonly outline: MarkdownOutline } | null>(null);
  const parsedTabRef = useRef<string | null>(null);
  parsedTabRef.current = parsed?.tabId ?? null;

  useEffect(() => {
    if (!enabled || content === null || tabId === null) return;
    const cached = cachedMarkdownOutline(content);
    if (cached) {
      setParsed({ tabId, outline: cached });
      return;
    }
    let cancelled = false;
    // 同一 tab 的编辑:防抖(期间沿用上次结果);换 tab:立即解析
    const delay = parsedTabRef.current === tabId ? OUTLINE_REPARSE_DEBOUNCE_MS : 0;
    const timer = setTimeout(() => {
      markdownOutlineOf(content).then(
        (outline) => {
          if (!cancelled) setParsed({ tabId, outline });
        },
        () => {},
      );
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, content, tabId]);

  if (!markdown || tabId === null) return { groupId, data: { status: 'no-editor' } };
  const fileName = basename(tab.filePath);
  if (parsed === null || parsed.tabId !== tabId) return { groupId, data: { status: 'loading', fileName } };
  return { groupId, data: { status: 'ready', fileName, outline: parsed.outline } };
}

/** 光标 / 视口所在的节(符号序号;-1 = 无)。监听各窗口的选区 / 按键 / 指针 / 滚动(按帧合并)与编辑器状态。 */
function useCurrentOrdinal(enabled: boolean, groupId: string, outline: MarkdownOutline | null): number {
  const [ordinal, setOrdinal] = useState(-1);
  const popoutDocs = useSyncExternalStore(subscribePopoutDocuments, getPopoutDocuments);
  useEffect(() => {
    if (!enabled || !outline) {
      setOrdinal(-1);
      return;
    }
    let frame = 0;
    const update = (): void => {
      frame = 0;
      setOrdinal(currentSymbolOrdinal(resolveSymbolTarget(groupId), outline));
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    const docs = [document, ...popoutDocs];
    const events = ['selectionchange', 'keyup', 'mouseup'] as const;
    for (const doc of docs) {
      for (const type of events) doc.addEventListener(type, schedule);
      doc.addEventListener('scroll', schedule, true);
    }
    const offStore = useEditorStore.subscribe(schedule);
    const offHandles = onMarkdownOutlineHandlesChange(schedule);
    update();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const doc of docs) {
        for (const type of events) doc.removeEventListener(type, schedule);
        doc.removeEventListener('scroll', schedule, true);
      }
      offStore();
      offHandles();
    };
  }, [enabled, groupId, outline, popoutDocs]);
  return ordinal;
}

function OutlineBody({ id }: { readonly id: string }) {
  const t = useT();
  const visible = useContext(ExplorerVisibleContext);
  const { groupId, data } = useActiveOutline(visible);
  const outline = data.status === 'ready' ? data.outline : null;
  const filter = useOutlineStore((s) => s.filter);
  const collapsed = useOutlineStore((s) => s.collapsed);
  const sortBy = useOutlineStore((s) => s.sortBy);
  const followCursor = useOutlineStore((s) => s.followCursor);
  const activeId = useOutlineStore((s) => s.activeId);
  const focusRequest = useOutlineStore((s) => s.focusRequest);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();

  const model = useMemo(
    () => buildOutlineRows(outline?.roots ?? [], { collapsed, filter: filter.trim(), sortBy }),
    [outline, collapsed, filter, sortBy],
  );
  const { rows } = model;
  // 「全部折叠」(标题栏按钮):按当前符号树折叠所有有子项的节
  const collapseAllRequest = useOutlineStore((s) => s.collapseAllRequest);
  const handledCollapseRef = useRef(collapseAllRequest);
  useEffect(() => {
    if (collapseAllRequest === handledCollapseRef.current) return;
    handledCollapseRef.current = collapseAllRequest;
    useOutlineStore.getState().collapseAll(model.collapsibleIds);
  }, [collapseAllRequest, model]);

  const current = useCurrentOrdinal(visible, groupId, outline);
  const currentRow = rowIndexOfOrdinal(model, current);
  const activeIndex = activeId === null ? -1 : (model.indexOf.get(activeId) ?? -1);

  // 跟随光标:当前节变了 → 活动行跟到它(或其可见祖先)
  const followRowId = currentRow >= 0 ? rows[currentRow]!.id : null;
  useEffect(() => {
    if (followCursor && followRowId !== null) useOutlineStore.getState().setActiveId(followRowId);
  }, [followCursor, followRowId]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  useEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex);
  }, [activeIndex, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const rowDomId = (i: number) => `${idPrefix}-row-${i}`;
  const activeRendered = activeIndex >= 0 && isVirtualIndexRendered(virtualItems, activeIndex);

  // 「聚焦到大纲视图」:有行 → 树;否则过滤框(只兑现挂载后的新请求)
  const handledFocusRef = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === handledFocusRef.current) return;
    handledFocusRef.current = focusRequest;
    if (rows.length > 0) {
      if (activeIndex < 0) useOutlineStore.getState().setActiveId(rows[0]!.id);
      treeRef.current?.focus();
    } else filterRef.current?.focus();
  }, [focusRequest, rows, activeIndex]);

  const open = (row: OutlineRow, focus: boolean): void => {
    useOutlineStore.getState().setActiveId(row.id);
    void revealSymbol(resolveSymbolTarget(groupId), row.symbol, { focus, record: true });
  };

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isImeComposing(e.nativeEvent) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      const el = treeRef.current;
      if (!el || rows.length === 0) return;
      e.preventDefault();
      const target = pageNavTarget(
        e.key === 'PageDown' ? 1 : -1,
        activeIndex,
        rows.length,
        measurePageNavGeometry(el, el.firstElementChild as HTMLElement | null, ROW_HEIGHT),
      );
      useOutlineStore.getState().setActiveId(rows[target]!.id);
      return;
    }
    const action = outlineKeyAction(rows, activeIndex, e.key);
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'move') useOutlineStore.getState().setActiveId(rows[action.index]!.id);
    else if (action.kind === 'toggle') useOutlineStore.getState().setCollapsed(action.id, !action.expand);
    else open(rows[action.index]!, e.key === 'Enter');
  };

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e.nativeEvent)) return;
    if (e.key === 'ArrowDown' && rows.length > 0) {
      e.preventDefault();
      if (activeIndex < 0) useOutlineStore.getState().setActiveId(rows[0]!.id);
      treeRef.current?.focus();
    } else if (e.key === 'Escape' && filter !== '') {
      e.preventDefault();
      useOutlineStore.getState().setFilter('');
    }
  };

  let empty: string | null = null;
  if (data.status === 'no-editor') empty = t('panels.outline.no_editor');
  else if (data.status === 'ready' && data.outline.flat.length === 0)
    empty = t('panels.outline.no_symbols', { name: data.fileName });
  else if (data.status === 'ready' && rows.length === 0) empty = t('panels.outline.no_match');

  const hasSymbols = data.status === 'ready' && data.outline.flat.length > 0;
  return (
    <div id={id} className="flex min-h-0 flex-1 flex-col">
      {hasSymbols && (
        <div className="px-2 pb-1">
          <Input
            ref={filterRef}
            size="sm"
            value={filter}
            placeholder={t('panels.outline.filter')}
            aria-label={t('panels.outline.filter')}
            onChange={(e) => useOutlineStore.getState().setFilter(e.target.value)}
            onKeyDown={onFilterKeyDown}
          />
        </div>
      )}
      {empty !== null ? (
        // 空状态(VSCode 同款文案):role=status,切换编辑器时读屏同样获知
        <div role="status" className="px-3 py-2 text-xs text-fg-dim">
          {empty}
        </div>
      ) : (
        <div
          ref={treeRef}
          role="tree"
          aria-label={t('panels.outline.title')}
          tabIndex={rows.length > 0 ? 0 : -1}
          aria-activedescendant={activeRendered ? rowDomId(activeIndex) : undefined}
          onKeyDown={onTreeKeyDown}
          onFocus={() => {
            if (activeIndex < 0 && rows.length > 0) useOutlineStore.getState().setActiveId(rows[0]!.id);
          }}
          className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((item) => {
              const row = rows[item.index]!;
              const selected = item.index === activeIndex;
              const isCurrent = item.index === currentRow;
              const sym = row.symbol;
              return (
                <div
                  key={row.id}
                  id={rowDomId(item.index)}
                  data-row-index={item.index}
                  data-current={isCurrent ? '' : undefined}
                  role="treeitem"
                  aria-level={row.level}
                  aria-expanded={row.hasChildren ? row.expanded : undefined}
                  aria-selected={selected}
                  aria-posinset={row.posInSet}
                  aria-setsize={row.setSize}
                  aria-label={sym.text || sym.name}
                  title={sym.name}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT,
                    transform: `translateY(${item.start}px)`,
                    paddingLeft: 4 + (row.level - 1) * INDENT_PX,
                  }}
                  className={`${pickerRowClassName(selected)} min-w-0 !gap-1`}
                  onClick={(e) => open(row, e.detail >= 2)}
                >
                  <span
                    aria-hidden="true"
                    className={`shrink-0 text-fg-muted transition-transform ${row.hasChildren ? '' : 'invisible'} ${row.expanded ? '' : '-rotate-90'}`}
                    onClick={(e) => {
                      // 展开 / 折叠只认箭头(VSCode expandOnlyOnTwistieClick);不触发定位
                      e.stopPropagation();
                      if (row.hasChildren) useOutlineStore.getState().setCollapsed(row.id, row.expanded);
                    }}
                  >
                    {CHEVRON_ICON}
                  </span>
                  <span className={`min-w-0 truncate ${isCurrent ? 'font-semibold text-fg' : ''}`}>
                    {highlightMatches(sym.name, row.matches, -(sym.level + 1))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
