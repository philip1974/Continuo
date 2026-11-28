// 在文件中查找视图(dock 单例面板 `search`,对齐 VSCode Search 视图):查询框 + 正则 / 大小写 / 全词开关 + 可折叠的包含 /
// 排除 glob;状态行(aria-live)给出计数 / 搜索中 / 无结果 / 截断 / 失败 / 已取消,无结果时附排除项提示与入口(打开设置 /
// 在所有文件中重新搜索,VSCode SearchView.onSearchComplete);搜索进行中顶部细进度条(延迟 300ms)+「取消搜索」按钮、
// 结果树 aria-busy,结果树上 Esc 取消(VSCode search.action.cancel);结果按文件分组的虚拟化树(role=tree,
// aria-activedescendant),键盘 ↑↓ / ←→ / Home / End / Enter,单击打开。状态与调度在 search-store。
// 结果行右键 / Shift+F10 菜单(VSCode MenuId.SearchContext),外壳同 tab 右键菜单(TabContextMenu)。
// BDD: src/__tests__/workspace-search/、src/__tests__/list-context-menus/

import { revealInvisibleChars } from '@/lib/untrusted-text';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useShallow } from 'zustand/react/shallow';
import { Badge, IconButton, Input, ProgressBar, TruncateStart, useDelayedActive } from '@/design';
import { isImeComposing } from '@/design/ime';
import { translateCount, useT } from '@/i18n';
import { matchFindOptionHotkey, type FindOption } from '@/lib/find-options';
import { FindOptionToggles } from '@/lib/FindOptionToggles';
import { localizeErrorByCode } from '@/lib/localize-error';
import { regexSyntaxError } from '@/lib/search-query';
import { TabContextMenu, type TabMenuEntry } from '@/lib/TabContextMenu';
import { copyToClipboardOrNotify } from '@/panels/Explorer/copy-to-clipboard';
import { ChevronDownIcon, ExcludeIcon, MoreActionsIcon, StopIcon } from '@/lib/ui-icons';
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import { OPEN_TO_SIDE_HOTKEY } from '@/panels/Explorer/tree-keyboard';
import { PICKER_MATCH_CLASS_NAME, pickerRowClassName, pickerRowSecondaryClassName } from '@/plugins/picker/picker-row';
import { isVirtualIndexRendered } from '@/plugins/picker/use-picker-list';
import { measurePageNavGeometry, pageNavTarget } from '@/lib/list-page-nav';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { openSettingsWithQuery } from '@/lib/toggle-settings-panel';
import { useGitStatus } from '@/panels/Explorer/hooks/useGitStatus';
import { fileGitDecoration, GIT_KIND_LABEL_KEY, GIT_KIND_TEXT_CLASS } from '@/panels/Explorer/git-decorations';
import { useSettingValue } from '@/plugins/settings/values-store';
import { SEARCH_DECORATIONS_BADGES, SEARCH_DECORATIONS_COLORS } from '@/plugins/settings/core-setting-specs';
import {
  addFileTypeToSearch,
  dismissSearchResult,
  matchRowKey,
  openSearchMatch,
  openSearchMatchToSide,
  useSearchStore,
  type SearchRowKey,
} from './search-store';
import { searchAllText, searchFileText, searchLineDelimiter, searchMatchText } from './search-copy';
import { SEARCH_MAX_FILES, type SearchFileResult } from '../../../electron/shared/workspace-search';

const ROW_HEIGHT = 22;
const STORE_OPTION: Readonly<Record<FindOption, 'matchCase' | 'wholeWord' | 'isRegex'>> = {
  caseSensitive: 'matchCase',
  wholeWord: 'wholeWord',
  regex: 'isRegex',
};
const CHEVRON_ICON = <ChevronDownIcon size={14} />;
const DETAILS_ICON = <MoreActionsIcon size={14} />;
const EXCLUDE_ICON = <ExcludeIcon size={14} />;
const STOP_ICON = <StopIcon size={14} />;
/** 进度条 / 「取消搜索」按钮的出现延迟(VSCode searchView withProgress delay 300):很快完成的搜索不闪。 */
export const SEARCH_PROGRESS_DELAY_MS = 300;
/**
 * 无结果提示「打开设置」的设置查询(照抄 VSCode SearchView.onOpenSettings):排除设置 + 各忽略文件设置。本项目目前只有
 * search.useIgnoreFiles,其余 id 无对应设置项、不显示。
 */
const SEARCH_EXCLUDE_SETTINGS_QUERY =
  '@id:files.exclude,search.exclude,search.useParentIgnoreFiles,search.useGlobalIgnoreFiles,search.useIgnoreFiles';
const PRE_STYLE = { whiteSpace: 'pre' } as const;

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
      useExcludesAndIgnoreFiles: st.useExcludesAndIgnoreFiles,
      detailsOpen: st.detailsOpen,
      status: st.status,
      files: st.files,
      resultCount: st.resultCount,
      limitHit: st.limitHit,
      filesLimitHit: st.filesLimitHit,
      skippedLarge: st.skippedLarge,
      skippedUnreadable: st.skippedUnreadable,
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

  // 工作区切换后的重搜在 search-store 里订阅 workspace.root(面板没打开时也作废旧结果)。
  const root = useWorkspaceStore((w) => w.root);

  // 结果文件行的 git 装饰(VSCode searchResultsView fileDecorations = search.decorations.colors / badges,默认都开);
  // 与资源管理器 / 编辑器 tab 共用窗口级数据源,无结果或两项都关时不查询。BDD: src/__tests__/editor-search-git-decorations/
  const gitColors = useSettingValue(SEARCH_DECORATIONS_COLORS.id, SEARCH_DECORATIONS_COLORS.default);
  const gitBadges = useSettingValue(SEARCH_DECORATIONS_BADGES.id, SEARCH_DECORATIONS_BADGES.default);
  const gitIndex = useGitStatus(root ?? '', (gitColors || gitBadges) && root !== null && s.files.length > 0, true);

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
  const statusAction = searchStatusAction(s);
  const searching = s.status === 'searching';
  const slowSearch = useDelayedActive(searching, SEARCH_PROGRESS_DELAY_MS);
  // 被点的「取消搜索」/ 行内链接随状态卸载,焦点交回查询框而不是掉到 body。VSCode:cancelSearch(focus = true) →
  // searchWidget.focus()(全选);「重新搜索」/「在所有文件中重新搜索」triggerQueryChange({ preserveFocus: false }) →
  // searchWidget.focus(false)(不全选)。
  const focusQueryInput = (select: boolean) => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (select) el.select();
  };
  const cancelSearch = () => {
    actions.cancelSearch();
    focusQueryInput(true);
  };
  const runStatusAction = () => {
    if (statusAction === 'open-settings') openSettingsWithQuery(SEARCH_EXCLUDE_SETTINGS_QUERY);
    else if (statusAction === 'search-all') {
      actions.searchInAllFiles();
      focusQueryInput(false);
    } else if (statusAction === 'search-again') {
      actions.searchNow();
      focusQueryInput(false);
    }
  };

  // preview:匹配行单击以预览方式打开(双击的第二下 / Enter 常驻;BDD: src/__tests__/editor-preview-tab/)
  const activate = (row: Row, preview = false) => {
    if (row.kind === 'file') actions.toggleCollapsed(row.file.path);
    else void openSearchMatch(row.file, row.index, preview);
  };

  const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Esc 取消在途搜索(VSCode search.action.cancel:焦点在结果列表时 Escape;同样经 cancelSearch() 把焦点交回查询框)
    if (e.key === 'Escape' && searching) {
      e.preventDefault();
      e.stopPropagation();
      cancelSearch();
      return;
    }
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
      // VSCode list.focusPageDown / focusPageUp:先到可视区末 / 首行,再按可视行数翻页(list-page-nav)
      case 'PageDown':
      case 'PageUp': {
        const el = treeRef.current;
        if (!el) return;
        const dir = e.key === 'PageDown' ? 1 : -1;
        return go(pageNavTarget(dir, activeIndex, rows.length, measurePageNavGeometry(el, el.firstElementChild as HTMLElement | null, ROW_HEIGHT)));
      }
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
        // 在侧边打开(VSCode search.action.openResultToSide:mac ⌃Enter、其它 Ctrl+Enter;只对匹配行)
        if (row.kind === 'match' && matchesHotkey(OPEN_TO_SIDE_HOTKEY, e.nativeEvent)) void openSearchMatchToSide(row.file, row.index);
        else activate(row);
        return;
    }
  };

  // 右键菜单(VSCode MenuId.SearchContext,同组同序):移除 / 排除 · 包含此文件类型(文件行)─ 复制 / 复制路径(文件行)/
  // 全部复制。右键的行成为活动行(VSCode 同);空白处只有「全部复制」;无结果不弹。
  // 跳过:替换类(本视图无替换)、文件夹行项(结果不按文件夹分组)、在资源管理器视图中显示(资源管理器无外部定位入口)。
  const menuRowRef = useRef<Row | null>(null);
  const onTreeContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-row-index]');
    const row = el ? (rows[Number(el.dataset['rowIndex'])] ?? null) : null;
    menuRowRef.current = row;
    if (row) actions.setActiveKey(row.key);
    else if (rows.length === 0) e.preventDefault(); // 阻止 Radix 打开空菜单
  };
  const menuEntries = (): TabMenuEntry[] => {
    const row = menuRowRef.current;
    const copyFailed = t('panels.terminal.ctx.copy_failed');
    const copy = (text: string) => () => void copyToClipboardOrNotify(text, copyFailed);
    const eol = searchLineDelimiter();
    const copyAll: TabMenuEntry = {
      label: t('panels.search.ctx.copy_all'),
      onSelect: () => void copyToClipboardOrNotify(searchAllText(useSearchStore.getState().files, eol), copyFailed),
    };
    if (!row) return [copyAll];
    const entries: TabMenuEntry[] = [{ label: t('panels.search.ctx.dismiss'), onSelect: () => dismissSearchResult(row.key) }];
    if (row.kind === 'file') {
      entries.push(
        { label: t('panels.search.ctx.exclude_file_type'), onSelect: () => addFileTypeToSearch(row.file, 'exclude') },
        { label: t('panels.search.ctx.include_file_type'), onSelect: () => addFileTypeToSearch(row.file, 'include') },
      );
    }
    entries.push('separator', {
      label: t('panels.search.ctx.copy'),
      onSelect: copy(row.kind === 'file' ? searchFileText(row.file, eol) : searchMatchText(row.file.matches[row.index]!)),
    });
    if (row.kind === 'file') {
      entries.push({ label: t('panels.explorer.ctx.copy_path'), onSelect: copy(row.file.path) });
    }
    entries.push(copyAll);
    return entries;
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

  // 三处查找共用的选项名称 / 切换键(src/lib/find-options):⌥⌘C / ⌥⌘W / ⌥⌘R(Windows / Linux Alt+C / W / R),焦点在本视图内即生效。
  const onViewKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(e.nativeEvent)) return;
    const option = matchFindOptionHotkey(e.nativeEvent);
    if (!option) return;
    e.preventDefault();
    // 截住冒泡:同键的全局命令(编辑器之外 ⌥⌘C = 复制路径)不再执行(VSCode 查找框里归切换选项)
    e.stopPropagation();
    actions.toggleOption(STORE_OPTION[option]);
  };

  return (
    <div className="relative flex h-full w-full min-w-0 flex-col bg-canvas text-fg" data-testid="search-panel" onKeyDown={onViewKeyDown}>
      <ProgressBar
        active={searching}
        delayMs={SEARCH_PROGRESS_DELAY_MS}
        aria-label={t('panels.search.searching')}
        className="absolute inset-x-0 top-0 z-10"
      />
      <div className="flex flex-col gap-1.5 border-b border-line p-2">
        {/* 窄宽(侧栏最窄 170)时选项按钮换到下一行靠右,不被面板右边界裁掉 */}
        <div className="flex min-w-0 flex-wrap items-center gap-1">
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
            className="min-w-24 flex-1"
          />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* 选项 toggle 组与终端 / Markdown 查找条共用(Aa / ab / .*) */}
            <FindOptionToggles
              values={{ caseSensitive: s.matchCase, wholeWord: s.wholeWord, regex: s.isRegex }}
              onToggle={(option) => actions.toggleOption(STORE_OPTION[option])}
            />
            {/* VSCode 搜索进行中把标题栏「清除」换成「取消搜索」;本视图无标题栏操作,放在选项按钮旁,与进度条同一延迟出现 */}
            {slowSearch && (
              <IconButton
                size="xs"
                aria-label={t('panels.search.cancel')}
                title={t('panels.search.cancel')}
                onClick={cancelSearch}
                className="shrink-0"
              >
                {STOP_ICON}
              </IconButton>
            )}
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
            {/* VSCode 排除框内的「使用排除设置与忽略文件」开关(默认开;关 → 本次搜索不用构建产物排除表与 .gitignore / .ignore) */}
            <div className="flex min-w-0 items-center gap-1">
              <Input
                size="sm"
                value={s.exclude}
                onChange={(e) => actions.setExclude(e.target.value)}
                placeholder={t('panels.search.exclude_placeholder')}
                aria-label={t('panels.search.exclude_label')}
                title={t('panels.search.exclude_placeholder')}
                className="min-w-0 flex-1"
              />
              <IconButton
                size="xs"
                aria-label={t('panels.search.use_excludes_and_ignore_files')}
                title={t('panels.search.use_excludes_and_ignore_files')}
                aria-pressed={s.useExcludesAndIgnoreFiles}
                onClick={actions.toggleUseExcludesAndIgnoreFiles}
                className="shrink-0"
              >
                {EXCLUDE_ICON}
              </IconButton>
            </div>
          </>
        )}
        <div
          title={regexError ?? undefined}
          className={`min-h-4 break-words text-xs ${s.status === 'invalid' || s.status === 'error' ? 'text-error' : 'text-fg-dim'}`}
        >
          <span role="status" aria-live="polite">
            {statusText}
          </span>
          {statusAction !== null && (
            <>
              {' '}
              {/* native:状态行内的行内文字链接(VSCode SearchLinkButton),design Button 的内边距 / 底色不适用;复用语义 token。 */}
              <button
                type="button"
                className="cursor-pointer rounded-sm text-accent underline-offset-2 hover:underline"
                onClick={runStatusAction}
              >
                {t(STATUS_ACTION_LABEL_KEY[statusAction])}
              </button>
            </>
          )}
        </div>
      </div>
      {/* Shift+F10 / 菜单键:焦点在树容器上,菜单定位到活动行 */}
      <TabContextMenu
        entries={menuEntries}
        keyboardAnchor={() => treeRef.current?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`) ?? null}
      >
        <div
          ref={treeRef}
          role="tree"
          aria-label={t('panels.search.results_label')}
          tabIndex={rows.length > 0 ? 0 : -1}
          aria-busy={searching || undefined}
          aria-activedescendant={activeRendered ? rowId(activeIndex) : undefined}
          onKeyDown={onTreeKeyDown}
          onContextMenu={onTreeContextMenu}
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
                const { name: rawName, dir: rawDir } = splitRel(row.file.relPath);
                // 文件名 / 目录里的双向控制 / 零宽字符可见化(只改显示)
                const name = revealInvisibleChars(rawName);
                const dir = revealInvisibleChars(rawDir);
                const count = row.file.matches.length;
                // 名称着色 + 字母(在匹配数左侧,与名称同色、aria-hidden);悬浮提示追加状态,可访问名称不加(VSCode fileMatchAriaLabel)
                const git = fileGitDecoration(gitIndex, root, row.file.path);
                const gitClass = git !== null && gitColors ? GIT_KIND_TEXT_CLASS[git.kind] : '';
                const gitLetter = git !== null && gitBadges ? git.letter : '';
                const gitLabel = git !== null && git.kind !== 'ignored' ? t(GIT_KIND_LABEL_KEY[git.kind]) : null;
                return (
                  <div
                    key={row.key}
                    id={rowId(item.index)}
                    data-row-index={item.index}
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={!row.collapsed}
                    aria-selected={selected}
                    aria-label={t('panels.search.file_aria', { path: row.file.relPath, results: translateCount('panels.search.result_count', count) })}
                    title={gitLabel === null ? row.file.relPath : `${row.file.relPath} · ${gitLabel}`}
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
                    {/* 超长时目录先收缩(收缩权重远大于文件名)、再截断文件名;徽标 shrink-0 始终可见(VSCode 搜索结果文件行同) */}
                    <span
                      className={`min-w-0 truncate font-medium ${gitClass || 'text-fg'}`}
                      data-git-title={gitClass ? git!.kind : undefined}
                    >
                      {name}
                    </span>
                    {dir && <span className={`min-w-0 shrink-[1000] truncate ${pickerRowSecondaryClassName(selected)}`}>{dir}</span>}
                    {gitLetter !== '' && (
                      <span aria-hidden="true" data-git-letter="" className={`ml-auto shrink-0 font-medium ${GIT_KIND_TEXT_CLASS[git!.kind]}`}>
                        {gitLetter}
                      </span>
                    )}
                    <Badge size="xs" className={`${gitLetter !== '' ? '' : 'ml-auto '}shrink-0`} aria-hidden="true">
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
                  data-row-index={item.index}
                  role="treeitem"
                  aria-level={2}
                  aria-selected={selected}
                  aria-label={t('panels.search.match_aria', { line: m.line, column: m.column, text: m.preview })}
                  title={m.preview}
                  style={style}
                  className={`${pickerRowClassName(selected)} min-w-0 pl-7`}
                  onClick={(e) => {
                    actions.setActiveKey(row.key);
                    activate(row, e.detail < 2);
                  }}
                >
                  {/* 预览用 UI 比例字体(VSCode .linematch 不设 font-family,继承工作台字体)。命中前文已按词边界截短
                      (workspace-search previewBefore);行仍放不下时先截后文(收缩权重大)、再从左侧截前文(TruncateStart,
                      省略号在左),命中词始终可见,过长的命中自身在末尾截断。三段都保留空白(white-space: pre):后文 / 命中
                      不用 truncate(它的 nowrap 会合并空格);前文的 Tab 与行尾空白由 TruncateStart 处理(rtl 截断下的双向重排)。 */}
                  <span className="flex min-w-0 whitespace-pre" data-search-preview="">
                    <TruncateStart text={m.preview.slice(0, m.previewStart)} title={m.preview} style={PRE_STYLE} data-preview-before="" />
                    <mark className={`${PICKER_MATCH_CLASS_NAME} max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-pre`}>
                      {m.preview.slice(m.previewStart, m.previewStart + m.previewLength)}
                    </mark>
                    <span className="min-w-0 shrink-[1000] overflow-hidden text-ellipsis whitespace-pre">
                      {m.preview.slice(m.previewStart + m.previewLength)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </TabContextMenu>
    </div>
  );
}

interface StatusInput {
  readonly status: string;
  /** 缺省 ''(旧调用方 / 测试未传)。 */
  readonly include?: string;
  readonly exclude?: string;
  /** 「使用排除设置与忽略文件」;缺省 true。 */
  readonly useExcludesAndIgnoreFiles?: boolean;
  readonly files: readonly SearchFileResult[];
  readonly resultCount: number;
  readonly limitHit: boolean;
  readonly filesLimitHit: boolean;
  readonly skippedLarge: number;
  /** 缺省 0(旧调用方 / 测试未传)。 */
  readonly skippedUnreadable?: number;
  readonly error: { readonly code: string; readonly message: string } | null;
}

type StatusAction = 'open-settings' | 'search-all' | 'search-again';
const STATUS_ACTION_LABEL_KEY = {
  'open-settings': 'panels.search.open_settings',
  'search-all': 'panels.search.search_all_files',
  'search-again': 'panels.search.search_again',
} as const satisfies Record<StatusAction, string>;

/**
 * 无结果时状态行后的行内入口(VSCode SearchView.onSearchComplete):取消时还没有结果 →「重新搜索」;有包含 / 排除条件 →
 * 「在所有文件中重新搜索」;否则在使用排除设置与忽略文件时 →「打开设置」(关掉开关后已不受它们影响,不提示)。
 */
export function searchStatusAction(s: StatusInput): StatusAction | null {
  if (s.resultCount > 0) return null;
  if (s.status === 'cancelled') return 'search-again';
  if (s.status !== 'done') return null;
  if ((s.include ?? '').trim() !== '' || (s.exclude ?? '').trim() !== '') return 'search-all';
  return s.useExcludesAndIgnoreFiles === false ? null : 'open-settings';
}

/** 无结果的主句:有包含 / 排除条件时写明(VSCode noResultsIncludes / noResultsExcludes / noResultsIncludesExcludes)。 */
function noResultsText(s: StatusInput, t: ReturnType<typeof useT>): string {
  const include = (s.include ?? '').trim();
  const exclude = (s.exclude ?? '').trim();
  if (include !== '' && exclude !== '') return t('panels.search.no_results_in_excluding', { include, exclude });
  if (include !== '') return t('panels.search.no_results_in', { include });
  if (exclude !== '') return t('panels.search.no_results_excluding', { exclude });
  return t('panels.search.no_results');
}

/** 状态行文案(VSCode 搜索视图消息):搜索中 / 计数 / 无结果 / 已取消 / 截断 / 文件数上限 / 失败 / 非法正则 / 无工作区。 */
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
  // 取消时还没有结果(VSCode searchCanceled);有结果 → 计数后注明已取消(结果不完整)。
  if (s.status === 'cancelled' && s.resultCount === 0) return t('panels.search.cancelled_no_results');
  const parts = [
    s.status === 'done' && s.resultCount === 0
      ? noResultsText(s, t)
      : t('panels.search.summary', {
          results: translateCount('panels.search.result_count', s.resultCount),
          files: translateCount('panels.search.file_count', s.files.length),
        }),
  ];
  if (s.status === 'cancelled') parts.push(t('panels.search.cancelled'));
  if (s.limitHit) parts.push(t('panels.search.limit_hit'));
  // 文件数上限 / 跳过大文件:无结果时同样提示(否则「未找到结果」看不出搜索范围不完整)。
  if (s.filesLimitHit) parts.push(t('panels.search.files_limit_hit', { max: SEARCH_MAX_FILES }));
  if (s.skippedLarge > 0) parts.push(translateCount('panels.search.skipped_large', s.skippedLarge));
  // 读不了的子目录(无权限 / 路径超长):已跳过,其余结果照常给出(VSCode / ripgrep 同);合成一条计数,不逐个刷屏。
  if ((s.skippedUnreadable ?? 0) > 0) {
    parts.push(translateCount('panels.search.skipped_unreadable', s.skippedUnreadable ?? 0));
  }
  // 无结果且受排除设置与忽略文件影响(VSCode noResultsFound「查看设置中配置的排除项并检查 gitignore 文件」),后接「打开设置」
  if (searchStatusAction(s) === 'open-settings') parts.push(t('panels.search.no_results_hint'));
  return parts.join(t('panels.search.message_separator'));
}
