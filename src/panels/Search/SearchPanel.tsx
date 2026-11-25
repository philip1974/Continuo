// 在文件中查找视图(dock 单例面板 `search`,对齐 VSCode Search 视图):查询框 + 正则 / 大小写 / 全词开关 + 可折叠的包含 /
// 排除 glob;状态行(aria-live)给出计数 / 搜索中 / 无结果 / 截断 / 失败;结果按文件分组的虚拟化树(role=tree,
// aria-activedescendant),键盘 ↑↓ / ←→ / Home / End / Enter,单击打开。状态与调度在 search-store。
// BDD: src/__tests__/workspace-search/

import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import { Badge, IconButton, Input } from '@/design';
import { isImeComposing } from '@/design/ime';
import { translateCount, useT } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { regexSyntaxError } from '@/lib/search-query';
import { ChevronDownIcon, MoreActionsIcon } from '@/lib/ui-icons';
import { PICKER_MATCH_CLASS_NAME, pickerRowClassName, pickerRowSecondaryClassName } from '@/plugins/picker/picker-row';
import { isVirtualIndexRendered } from '@/plugins/picker/use-picker-list';
import { useWorkspaceStore } from '@/stores/workspace.store';
import {
  matchRowKey,
  openSearchMatch,
  rerunSearch,
  useSearchStore,
  type SearchRowKey,
} from './search-store';
import { SEARCH_MAX_FILES, type SearchFileResult } from '../../../electron/shared/workspace-search';

const ROW_HEIGHT = 22;
const CHEVRON_ICON = <ChevronDownIcon size={14} />;
const DETAILS_ICON = <MoreActionsIcon size={14} />;

type Row =
  | { readonly kind: 'file'; readonly key: SearchRowKey; readonly file: SearchFileResult; readonly collapsed: boolean }
  | { readonly kind: 'match'; readonly key: SearchRowKey; readonly file: SearchFileResult; readonly index: number };

function buildRows(files: readonly SearchFileResult[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    const isCollapsed = collapsed.has(file.path);
    rows.push({ kind: 'file', key: file.path, file, collapsed: isCollapsed });
    if (isCollapsed) continue;
    for (let i = 0; i < file.matches.length; i += 1) rows.push({ kind: 'match', key: matchRowKey(file.path, i), file, index: i });
  }
  return rows;
}

function splitRel(relPath: string): { name: string; dir: string } {
  const at = relPath.lastIndexOf('/');
  return at < 0 ? { name: relPath, dir: '' } : { name: relPath.slice(at + 1), dir: relPath.slice(0, at) };
}

export function SearchPanel() {
  const t = useT();
  const s = useSearchStore(
    useShallow((st) => ({
      pattern: st.pattern,
      isRegex: st.isRegex,
      matchCase: st.matchCase,
      wholeWord: st.wholeWord,
      include: st.include,
      exclude: st.exclude,
      detailsOpen: st.detailsOpen,
      status: st.status,
      files: st.files,
      resultCount: st.resultCount,
      limitHit: st.limitHit,
      filesLimitHit: st.filesLimitHit,
      error: st.error,
      collapsed: st.collapsed,
      activeKey: st.activeKey,
      focusRequest: st.focusRequest,
    })),
  );
  const actions = useSearchStore.getState();
  const idPrefix = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // ⇧⌘F:焦点进查询框并全选(已打开时面板不重挂,靠 focusRequest)。只兑现未处理过的请求 —— 启动恢复出的面板 /
  // 拖进 popout 重挂载不抢焦点。
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || s.focusRequest === useSearchStore.getState().focusHandled) return;
    useSearchStore.setState({ focusHandled: s.focusRequest });
    el.focus();
    el.select();
  }, [s.focusRequest]);

  // 工作区切换:旧结果作废,按当前查询重搜。
  const root = useWorkspaceStore((w) => w.root);
  const rootRef = useRef(root);
  useEffect(() => {
    if (rootRef.current === root) return;
    rootRef.current = root;
    rerunSearch();
  }, [root]);

  const rows = useMemo(() => buildRows(s.files, s.collapsed), [s.files, s.collapsed]);
  const activeIndex = s.activeKey === null ? -1 : rows.findIndex((r) => r.key === s.activeKey);
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
  const rowId = (i: number) => `${idPrefix}-row-${i}`;
  const activeRendered = activeIndex >= 0 && isVirtualIndexRendered(virtualItems, activeIndex);

  const regexError = s.isRegex && s.pattern ? regexSyntaxError(s.pattern) : null;
  const statusText = searchStatusText(s, t);

  const activate = (row: Row) => {
    if (row.kind === 'file') actions.toggleCollapsed(row.file.path);
    else void openSearchMatch(row.file, row.index);
  };

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;
    const cur = activeIndex < 0 ? 0 : activeIndex;
    const row = rows[cur]!;
    const go = (i: number) => {
      e.preventDefault();
      actions.setActiveKey(rows[Math.max(0, Math.min(rows.length - 1, i))]!.key);
    };
    switch (e.key) {
      case 'ArrowDown':
        return go(activeIndex < 0 ? 0 : cur + 1);
      case 'ArrowUp':
        return go(cur - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(rows.length - 1);
      case 'ArrowRight':
        if (row.kind !== 'file') return;
        e.preventDefault();
        if (row.collapsed) actions.toggleCollapsed(row.file.path, false);
        else go(cur + 1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (row.kind === 'match') actions.setActiveKey(row.file.path);
        else actions.toggleCollapsed(row.file.path, true);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        actions.setActiveKey(row.key);
        activate(row);
        return;
    }
  };

  const onQueryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e.nativeEvent)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      actions.searchNow();
    } else if (e.key === 'ArrowDown' && rows.length > 0) {
      e.preventDefault();
      if (activeIndex < 0) actions.setActiveKey(rows[0]!.key);
      treeRef.current?.focus();
    }
  };

  const toggle = (label: string, pressed: boolean, option: 'isRegex' | 'matchCase' | 'wholeWord', glyph: ReactNode) => (
    <IconButton size="xs" aria-label={label} title={label} aria-pressed={pressed} onClick={() => actions.toggleOption(option)}>
      {glyph}
    </IconButton>
  );

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-canvas text-fg" data-testid="search-panel">
      <div className="flex flex-col gap-1.5 border-b border-line p-2">
        <div className="flex min-w-0 items-center gap-1">
          <Input
            ref={inputRef}
            size="sm"
            value={s.pattern}
            onChange={(e) => actions.setPattern(e.target.value)}
            onKeyDown={onQueryKeyDown}
            placeholder={t('panels.search.query_label')}
            aria-label={t('panels.search.query_label')}
            aria-invalid={regexError ? true : undefined}
            title={regexError ?? undefined}
            className="min-w-0 flex-1"
          />
          <div role="group" aria-label={t('panels.terminal.search.options_group')} className="inline-flex shrink-0 items-center gap-0.5">
            {toggle(t('panels.terminal.search.case_sensitive'), s.matchCase, 'matchCase', 'Aa')}
            {toggle(t('panels.terminal.search.whole_word'), s.wholeWord, 'wholeWord', 'ab')}
            {toggle(t('panels.terminal.search.regex'), s.isRegex, 'isRegex', '.*')}
          </div>
          <IconButton
            size="xs"
            aria-label={t('panels.search.toggle_details')}
            title={t('panels.search.toggle_details')}
            aria-expanded={s.detailsOpen}
            onClick={actions.toggleDetails}
            className="shrink-0"
          >
            {DETAILS_ICON}
          </IconButton>
        </div>
        {s.detailsOpen && (
          <>
            <Input
              size="sm"
              value={s.include}
              onChange={(e) => actions.setInclude(e.target.value)}
              placeholder={t('panels.search.include_placeholder')}
              aria-label={t('panels.search.include_label')}
              title={t('panels.search.include_placeholder')}
            />
            <Input
              size="sm"
              value={s.exclude}
              onChange={(e) => actions.setExclude(e.target.value)}
              placeholder={t('panels.search.exclude_placeholder')}
              aria-label={t('panels.search.exclude_label')}
              title={t('panels.search.exclude_placeholder')}
            />
          </>
        )}
        <div
          role="status"
          aria-live="polite"
          title={regexError ?? undefined}
          className={`min-h-4 break-words text-xs ${s.status === 'invalid' || s.status === 'error' ? 'text-error' : 'text-fg-dim'}`}
        >
          {statusText}
        </div>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label={t('panels.search.results_label')}
        tabIndex={rows.length > 0 ? 0 : -1}
        aria-activedescendant={activeRendered ? rowId(activeIndex) : undefined}
        onKeyDown={onTreeKeyDown}
        onFocus={() => {
          if (activeIndex < 0 && rows.length > 0) actions.setActiveKey(rows[0]!.key);
        }}
        className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-solid focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-focus-ring"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((item) => {
            const row = rows[item.index]!;
            const selected = item.index === activeIndex;
            const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` };
            if (row.kind === 'file') {
              const { name, dir } = splitRel(row.file.relPath);
              const count = row.file.matches.length;
              return (
                <div
                  key={row.key}
                  id={rowId(item.index)}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={!row.collapsed}
                  aria-selected={selected}
                  aria-label={t('panels.search.file_aria', { path: row.file.relPath, results: translateCount('panels.search.result_count', count) })}
                  title={row.file.relPath}
                  style={style}
                  className={`${pickerRowClassName(selected)} min-w-0 pl-1`}
                  onClick={() => {
                    actions.setActiveKey(row.key);
                    activate(row);
                  }}
                >
                  <span className={`shrink-0 text-fg-muted transition-transform ${row.collapsed ? '-rotate-90' : ''}`} aria-hidden="true">
                    {CHEVRON_ICON}
                  </span>
                  <span className="shrink-0 truncate font-medium text-fg">{name}</span>
                  {dir && <span className={`min-w-0 truncate ${pickerRowSecondaryClassName(selected)}`}>{dir}</span>}
                  <Badge size="xs" className="ml-auto shrink-0" aria-hidden="true">
                    {row.file.truncated ? `${count}+` : count}
                  </Badge>
                </div>
              );
            }
            const m = row.file.matches[row.index]!;
            return (
              <div
                key={row.key}
                id={rowId(item.index)}
                role="treeitem"
                aria-level={2}
                aria-selected={selected}
                aria-label={t('panels.search.match_aria', { line: m.line, column: m.column, text: m.preview })}
                title={m.preview}
                style={style}
                className={`${pickerRowClassName(selected)} min-w-0 pl-7`}
                onClick={() => {
                  actions.setActiveKey(row.key);
                  activate(row);
                }}
              >
                <span className="min-w-0 truncate whitespace-pre font-mono">
                  {m.preview.slice(0, m.previewStart)}
                  <mark className={PICKER_MATCH_CLASS_NAME}>{m.preview.slice(m.previewStart, m.previewStart + m.previewLength)}</mark>
                  {m.preview.slice(m.previewStart + m.previewLength)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface StatusInput {
  readonly status: string;
  readonly files: readonly SearchFileResult[];
  readonly resultCount: number;
  readonly limitHit: boolean;
  readonly filesLimitHit: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** 状态行文案(VSCode 搜索视图消息):搜索中 / 计数 / 无结果 / 截断 / 文件数上限 / 失败 / 非法正则 / 无工作区。 */
export function searchStatusText(s: StatusInput, t: ReturnType<typeof useT>): string {
  switch (s.status) {
    case 'invalid':
      return t('editor.find.invalid_regex');
    case 'no-workspace':
      return t('quick_open.no_workspace');
    case 'error':
      return t('panels.search.failed', { reason: s.error ? localizeErrorByCode(s.error.code, s.error.message) : '' });
    case 'idle':
      return '';
  }
  if (s.status === 'searching' && s.resultCount === 0) return t('panels.search.searching');
  if (s.status === 'done' && s.resultCount === 0) return t('panels.search.no_results');
  const parts = [
    t('panels.search.summary', {
      results: translateCount('panels.search.result_count', s.resultCount),
      files: translateCount('panels.search.file_count', s.files.length),
    }),
  ];
  if (s.limitHit) parts.push(t('panels.search.limit_hit'));
  if (s.filesLimitHit) parts.push(t('panels.search.files_limit_hit', { max: SEARCH_MAX_FILES }));
  return parts.join(t('panels.search.message_separator'));
}
