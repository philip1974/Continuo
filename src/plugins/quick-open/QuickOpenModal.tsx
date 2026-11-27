// Quick Open Modal(VSCode ⌘P 同款)— UI 仿 CommandPalette.
//
// 数据流:
//   挂载(= 打开,body 只在打开时挂载)或 root / reloadToken 变化 → walkWorkspaceFiles →
//   setLoading(true) → 拿到 files → setResults(files, root) + setLoading(false)
//   query 变 → filterQuickOpenFiles(results):VSCode 文件打分(文件名优先、空格拆段,见 quick-open-filter)→ 渲染列表
//   Enter → openFileByPath(absPath) + close();⌘Enter / ⌥Enter(Windows / Linux Ctrl+Enter / Alt+Enter)→ 在侧边打开
//   (VSCode anythingQuickAccess SIDE_GROUP;`文件:行` 同样跳行)。BDD: src/__tests__/open-to-side-from-pickers/
//   最近打开(VSCode 编辑器历史):空查询时本工作区最近打开的文件排最前、首行标「最近打开」;有查询时同分优先。
//   BDD: src/__tests__/quick-open-recent/
//   转到行 / 列:查询以 `:` 开头(⌃G 预填)→ 列表换成唯一一行「转到第 N 行」/ 提示,Enter 跳转(见 use-goto-line)。
//   BDD: src/__tests__/editor-goto-line/
//   文件名:行号(`long.ts:200`、`a.ts:3:5`、`a.ts(3,5)`,VSCode 同):剥掉末尾行列再匹配文件,打开后跳到该行(居中)。
//   BDD: src/__tests__/quick-open-file-line/
//   转到编辑器中的符号:查询以 `@` 开头(⇧⌘O 预填;`@:` 按类别分组)→ 列表换成活动编辑器的符号(Markdown 标题),
//   选中项跟随预览、Enter 跳转(见 use-goto-symbol)。BDD: src/__tests__/markdown-outline/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePickerList } from '../picker/use-picker-list';
import { pickerRowClassName, pickerRowSecondaryClassName } from '../picker/picker-row';
import { Button, Input, Modal, Spinner, TruncateStart } from '@/design';
import { QUICK_OPEN_MAX_FILES, useQuickOpenStore, type QuickOpenFile } from './store';
import { walkWorkspaceFiles } from './walk-files';
import { orderByRecent, recentFilesFor } from './recent-files';
import { fuzzyMatchIndices } from '../command-palette/fuzzy';
import { filterQuickOpenFiles } from './quick-open-filter';
import { matchesToIndices, type ItemScore } from '@/lib/fuzzy-scorer';
import { highlightMatches } from '../picker/highlight-matches';
import { formatHotkey, detectPlatform } from '../command-palette/format-hotkey';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useSettingValue } from '@/plugins/settings/values-store';
import { SEARCH_USE_IGNORE_FILES } from '@/plugins/settings/core-setting-specs';
import { coApi } from '@/lib/co-api';
import { translateCount, useT } from '@/i18n';
import { dirname } from '@/lib/path-cross';
import { openFileByPath, type OpenFileOptions } from '@/panels/Editor/editor-file-actions';
import { preloadCodeEditorEngine } from '@/panels/Editor/editor-engine-loaders';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { editorFileDeps } from '@/panels/Editor/editor-file-deps';
import { focusActiveEditor } from '@/panels/Editor/editor-focus-registry';
import { normalizeSearchQuery } from '@/lib/search-query';
import { useGotoLine } from './use-goto-line';
import { useGotoSymbol } from './use-goto-symbol';
import { parseFileLineQuery, type GotoLineRequest } from './goto-line';
import { openFileInEditor, type EditorRevealOptions } from '@/plugins/co-app';
import { takeSideEditorGroup } from '@/shell/dock/explorer-editor-drop';
import { matchesHotkey } from '../command-palette/useCommandHotkeys';
import type { TextEncodingId } from '../../../electron/shared/text-encoding';

/** 在侧边打开:⌥Enter,或 ⌘Enter(Windows / Linux Ctrl+Enter)—— VSCode anythingQuickAccess 常驻打开时 keyMods.alt || keyMods.ctrlCmd。 */
function isOpenToSideEnter(e: KeyboardEvent): boolean {
  return matchesHotkey('mod+enter', e) || matchesHotkey('alt+enter', e);
}

/** ⌘P 打开为常驻(VSCode workbench.editor.enablePreviewFromQuickOpen 默认 false)。 */
const PINNED: OpenFileOptions = { preview: false };
const CLAMP: EditorRevealOptions = { clampToDocument: true };

// race(R2):稳定空数组引用,跨 root 时 liveResults 返回它,避免每次渲染新建 [] 触发 useMemo。
const EMPTY_RESULTS: readonly QuickOpenFile[] = [];
const QUICK_OPEN_SHORTCUT_LABEL = formatHotkey(
  'mod+shift+p',
  detectPlatform(),
);

const NO_HIGHLIGHTS = { name: null, dir: null } as const;

/** 行内命中字符(VSCode Quick Open:文件名与目录分别高亮),取自打分时的命中区段。只为渲染的可见行换算。 */
function matchHighlights(
  score: ItemScore | undefined,
): { readonly name: readonly number[] | null; readonly dir: readonly number[] | null } {
  if (!score) return NO_HIGHLIGHTS;
  return { name: matchesToIndices(score.labelMatch), dir: matchesToIndices(score.descriptionMatch) };
}

/**
 * 轻量 shell(打磨 R33,仿 R32 CommandPalette):QuickOpenModal 常驻挂在 App 顶层。
 * 外层只订阅 isOpen/close 渲染 Modal,**仅 isOpen 时才挂载 QuickOpenBody** —— 关闭
 * 状态下不再订阅 query/results/root/loading、不跑 fuzzyFilter、不创建 virtualizer。
 * results 仍留在 store,支持秒级再开复用。
 */
export function QuickOpenModal() {
  const isOpen = useQuickOpenStore((s) => s.isOpen);
  const close = useQuickOpenStore((s) => s.close);
  if (!isOpen) return null;
  return <QuickOpenDialog close={close} />;
}

interface QuickOpenDialogProps {
  readonly close: () => void;
}

function QuickOpenDialog({ close }: QuickOpenDialogProps) {
  const t = useT(); // a11y(A13):给无标题 dialog 命名
  return (
    <Modal
      visible
      onClose={close}
      size="lg"
      className="!p-0 !rounded-md"
      // a11y(A13):无可见标题的 dialog → aria-label 命名(复用 input_aria「搜索文件」)。
      aria-label={t('quick_open.input_aria')}
    >
      <QuickOpenBody />
    </Modal>
  );
}

function QuickOpenBody() {
  const t = useT();
  const query = useQuickOpenStore((s) => s.query);
  const selectedIndex = useQuickOpenStore((s) => s.selectedIndex);
  const results = useQuickOpenStore((s) => s.results);
  const resultsRoot = useQuickOpenStore((s) => s.resultsRoot);
  const skippedDirs = useQuickOpenStore((s) => s.skippedDirs);
  const loading = useQuickOpenStore((s) => s.loading);
  const close = useQuickOpenStore((s) => s.close);
  const setQuery = useQuickOpenStore((s) => s.setQuery);
  const moveSelection = useQuickOpenStore((s) => s.moveSelection);
  const clampSelection = useQuickOpenStore((s) => s.clampSelection);
  const setResults = useQuickOpenStore((s) => s.setResults);
  const setLoading = useQuickOpenStore((s) => s.setLoading);
  const scanFailed = useQuickOpenStore((s) => s.scanFailed);
  const setScanFailed = useQuickOpenStore((s) => s.setScanFailed);

  const root = useWorkspaceStore((s) => s.root);
  // VSCode:Quick Open 的文件列表同样遵从 search.useIgnoreFiles(.gitignore / .ignore);设置变化 → 重扫
  const useIgnoreFiles = useSettingValue(SEARCH_USE_IGNORE_FILES.id, SEARCH_USE_IGNORE_FILES.default);
  // 重试令牌:walk 失败后用户点"重试"递增 → 重跑 effect。
  const [reloadToken, setReloadToken] = useState(0);
  const inputAriaLabel = t('quick_open.input_aria');
  const placeholderLabel = t('quick_open.placeholder', {
    shortcut: QUICK_OPEN_SHORTCUT_LABEL,
  });

  // perf:面板打开即预热 Editor 面板 + CodeEditor chunk(共享 loader 去重、失败不缓存),选中文件回车时引擎
  // 多半已就绪。fire-and-forget,失败吞掉(真正渲染时由引擎错误边界处理)。
  useEffect(() => {
    preloadCodeEditorEngine().catch(() => {});
  }, []);

  // 打开 modal 时(或 root 变化)异步 walk 文件。已有 results 不阻塞 UI,
  // 后台刷新 → setResults。
  useEffect(() => {
    // body 仅在 isOpen 时挂载(打磨 R33),故无需再判 isOpen,挂载即等于打开。
    if (!root) return;
    let cancelled = false;
    // race(R2):若 store 里的 results 属于另一个 root(切 workspace 后重开),立即清空并标记
    // 当前 root,否则扫描期间渲染会展示/允许打开旧 workspace 文件(跨 root 泄漏)。同 root 保留
    // 复用优化(不清,后台刷新)。
    if (useQuickOpenStore.getState().resultsRoot !== root) {
      setResults([], root);
    }
    setLoading(true);
    setScanFailed(false);
    void walkWorkspaceFiles({
      rootPath: root,
      listDir: (p, opts) => coApi.fs.scanFiles(p, opts),
      useIgnoreFiles,
    })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setResults(r.data, root, r.skippedDirs ?? 0);
        } else {
          // walk 失败:置 scanFailed 标志,UI 显式区分"扫描失败 + 重试"与"空 workspace",
          // 不再让失败静默伪装成空列表把用户引向死胡同。见第二十一轮 P1-AY。
          console.warn('[quick-open] walk failed', r.code, r.message);
          setResults([], root);
          setScanFailed(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[quick-open] walk threw', err);
        setResults([], root);
        setScanFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, reloadToken, useIgnoreFiles, setResults, setLoading, setScanFailed]);

  // 打分照 VSCode:先对文件名、再对「目录 / 文件名」(能输 'src/foo' 这种路径片段);查询按空格拆段(见 quick-open-filter)。
  // 性能 P16:打分用预计算的 relPathLower(scan 时一次),不每按键对全部候选(≤ QUICK_OPEN_MAX_FILES)重 lowercasing。
  // race(R2):只信任归属当前 root 的 results;effect 异步清理前的一帧也不展示旧 root 结果。
  const liveResults = useMemo(
    () => (resultsRoot === root ? results : EMPTY_RESULTS),
    [resultsRoot, root, results],
  );
  // `文件:行[:列]` → 按剥掉行列的部分匹配文件,打开时跳到该行
  const fileLine = useMemo(() => parseFileLineQuery(query), [query]);
  const effectiveQuery = normalizeSearchQuery(fileLine?.filter ?? query);
  // 最近打开:打开面板时读一次(面板打开期间不会再打开文件)。已删除的文件不在扫描结果里,orderByRecent 自然略去。
  const recentPaths = useMemo(() => (root ? recentFilesFor(root) : []), [root]);
  const ordered = useMemo(() => orderByRecent(liveResults, recentPaths), [liveResults, recentPaths]);
  const { files: filtered, scores } = useMemo(
    () => filterQuickOpenFiles(ordered.items, ordered.recentCount, effectiveQuery),
    [ordered, effectiveQuery],
  );
  const recentCount = effectiveQuery ? 0 : ordered.recentCount;
  const recentLabel = t('quick_open.recently_opened');
  // 候选扫描到上限被截断:有结果与无匹配时都提示(第二十四轮:旧实现只在有结果时提示,截断导致的「无匹配」看不出原因)。
  // a11y(A65,A56 同族):动态出现的信息,焦点锁在搜索框时 SR 也须获知搜索范围不完整 → role=status(polite 中性提示)。
  // 读不了的子目录(无权限 / 路径超长):已跳过,其余文件照常可搜(VSCode / ripgrep 同);一条计数提示,不逐个刷屏。
  const liveSkippedDirs = resultsRoot === root ? skippedDirs : 0;
  const limitHint =
    liveResults.length >= QUICK_OPEN_MAX_FILES || liveSkippedDirs > 0 ? (
      <div role="status" className="px-3 py-1 text-center text-2xs text-fg-dim">
        {liveResults.length >= QUICK_OPEN_MAX_FILES && (
          <div>{t('quick_open.limit_hint', { max: QUICK_OPEN_MAX_FILES })}</div>
        )}
        {liveSkippedDirs > 0 && <div>{translateCount('quick_open.skipped_unreadable', liveSkippedDirs)}</div>}
      </div>
    ) : null;

  // 虚拟化列表(打磨 R25):filtered 仍是逻辑全集(最多 QUICK_OPEN_MAX_FILES),但只渲染可视行,
  // DOM 节点只有几十。复用项目已有 @tanstack/react-virtual(同
  // FolderTree)。selectedIndex / Enter 语义不变,键盘移动时 scrollToIndex 跟随。
  const lineTarget = fileLine?.target;
  const openFile = useCallback(
    async (file: QuickOpenFile, at: GotoLineRequest | undefined = lineTarget, toSide = false) => {
      close();
      // 在侧边打开(VSCode:⌥Enter,或常驻打开时 ⌘Enter / Ctrl+Enter → SIDE_GROUP):右边没有编辑器组就先拆出一个
      const side = toSide ? takeSideEditorGroup() : undefined;
      const pinned: OpenFileOptions = side === undefined ? PINNED : { ...PINNED, groupId: side };
      // 打开失败弹 error toast(modal 已关,旧实现只 console.warn → 用户点了没反应;P1-AX),按 code 本地化(I8)。
      // 成功 → 焦点进编辑器(VSCode:回车后可直接打字;否则弹窗还焦点给的旧编辑器随即卸载,焦点掉到 body)。
      // 带行号:与搜索结果同一条「打开并定位」(居中;Markdown 编辑 / 预览按源码行),导航记录只记目标一条。
      // 常驻打开(见 PINNED;已是预览 tab 的转常驻);行列越界夹到文档范围(VSCode 同;同 ⌃G 转到行)
      const open = at
        ? () =>
            openFileInEditor(file.absPath, { line: at.line, ...(at.column ? { column: at.column } : {}) }, pinned, CLAMP)
        : () => openFileByPath(file.absPath, editorFileDeps, pinned);
      // 不是 UTF-8 → 弹编码选择器,选定后按该编码打开(行号定位不保留;BDD: src/__tests__/editor-text-encoding/)
      const openWithEncoding = (encoding: TextEncodingId) =>
        openFileByPath(file.absPath, editorFileDeps, { ...pinned, encoding }).then((r) => {
          if (r.ok) focusActiveEditor();
          return r;
        });
      if (await openFileOrNotify(open, file.name, undefined, openWithEncoding)) {
        focusActiveEditor();
      }
    },
    [close, lineTarget],
  );

  // 列表机制(virtualizer / 越界钳制 / 滚动跟随 / 键盘导航 / ARIA)走共享 usePickerList。
  // filtered 仍是逻辑全集(最多 QUICK_OPEN_MAX_FILES),只渲染可视行。
  const gotoLine = useGotoLine(query, close);
  const gotoSymbol = useGotoSymbol(query, selectedIndex, close);
  const { scrollRef, virtualItems, comboboxProps, listboxProps, getOptionProps } = usePickerList({
    idPrefix: 'quick-open',
    count: gotoLine.active ? (gotoLine.canAccept ? 1 : 0) : gotoSymbol.active ? gotoSymbol.items.length : filtered.length,
    selectedIndex,
    rowHeight: 28, // li: py-1.5 text-xs ≈ 28px
    overscan: 12,
    moveSelection,
    clampSelection,
    onEnter: (index, e) => {
      if (gotoLine.active) {
        gotoLine.accept();
        return;
      }
      if (gotoSymbol.active) {
        gotoSymbol.accept(index);
        return;
      }
      const file = filtered[index];
      if (file) void openFile(file, lineTarget, isOpenToSideEnter(e.nativeEvent));
    },
  });

  return (
    <div className="flex flex-col">
      <div className="border-b border-line p-2">
        <Input
          size="sm"
          // 初始焦点用 data-autofocus(Modal 下一帧聚焦),不用 React autoFocus:后者在 commit 期就聚焦,
          // Modal 随后记下的「打开前焦点」变成本输入框,Esc 关闭后焦点掉到 body。
          data-autofocus
          // a11y(A2,A1 同族):placeholder 含快捷键参数不适合作可访问名;用专用简洁
          // aria-label,给屏幕阅读器稳定的「搜索文件」名称。
          aria-label={inputAriaLabel}
          {...comboboxProps}
          placeholder={placeholderLabel}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div ref={scrollRef} className="max-h-[min(420px,calc(100vh-8rem))] overflow-y-auto py-1">
        {gotoLine.active ? (
          gotoLine.canAccept ? (
            <ul {...listboxProps} aria-label={t('quick_open.list_aria')}>
              {virtualItems.map((vRow) => (
                <li
                  key="goto-line"
                  {...getOptionProps(vRow)}
                  className={pickerRowClassName(vRow.index === selectedIndex)}
                  onClick={gotoLine.accept}
                >
                  <span className="truncate">{gotoLine.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            // 无可跳转目标(只有 `:` / 没有文本编辑器):提示文字,焦点在输入框时读屏同样播报
            <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
              {gotoLine.message}
            </div>
          )
        ) : gotoSymbol.active ? (
          gotoSymbol.items.length > 0 ? (
            <ul {...listboxProps} aria-label={t('quick_open.symbol.list_aria')}>
              {virtualItems.map((vRow) => {
                const idx = vRow.index;
                const sym = gotoSymbol.items[idx]!;
                const container = gotoSymbol.containerOf(sym);
                const hl = gotoSymbol.filter ? fuzzyMatchIndices(gotoSymbol.filter, sym.text) : null;
                return (
                  <li
                    key={sym.ordinal}
                    {...getOptionProps(vRow)}
                    className={pickerRowClassName(idx === selectedIndex)}
                    title={sym.name}
                    onClick={() => gotoSymbol.accept(idx)}
                  >
                    {/* 名称(VSCode:`## 标题`)命中字符高亮(匹配源是标题文字,名称前有 级别 + 1 个字符);右侧容器名 + 首行分组标签 */}
                    <span className="min-w-0 shrink truncate font-medium">{highlightMatches(sym.name, hl, -(sym.level + 1))}</span>
                    {container !== undefined && (
                      <span className={`min-w-0 flex-1 truncate text-2xs ${pickerRowSecondaryClassName(idx === selectedIndex)}`}>
                        {container}
                      </span>
                    )}
                    {idx === 0 && (
                      <span className={`ml-auto shrink-0 pl-2 text-2xs ${pickerRowSecondaryClassName(idx === selectedIndex)}`}>
                        {gotoSymbol.groupLabel}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            // 无编辑器 / 不提供符号 / 无符号 / 无匹配(VSCode 同款提示);焦点在输入框时读屏同样播报
            <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
              {gotoSymbol.message}
            </div>
          )
        ) : !root ? (
          // a11y(A69,A56 同族):弹窗打开焦点自动落搜索框,无 workspace 空态须 role=status,
          // 否则 SR 用户不被告知"当前无法搜索文件"及原因。
          <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
            {t('quick_open.no_workspace')}
          </div>
        ) : loading && liveResults.length === 0 ? (
          // a11y(A102,A93 同族):扫描中态须 role=status 播报「正在扫描」具体语义,Spinner 自带
          // 泛化 role=status+aria-label="Loading" → 给 Spinner aria-hidden 抑制,避免双 status
          // 且只听到泛化 loading。
          <div
            role="status"
            className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-fg-dim"
          >
            <Spinner size="sm" aria-hidden />
            <span>{t('quick_open.scanning')}</span>
          </div>
        ) : scanFailed && liveResults.length === 0 ? (
          // 扫描失败:与"空 workspace"区分 + 给重试入口,不让失败静默伪装成空。
          // a11y(A45,A41 同族):异步插入的扫描失败提示须 role=alert,焦点在搜索框时也能播报。
          <div
            role="alert"
            className="flex flex-col items-center gap-2 px-3 py-6 text-center text-xs text-fg-dim"
          >
            <span>{t('quick_open.scan_failed')}</span>
            <Button size="sm" variant="ghost" onClick={() => setReloadToken((n) => n + 1)}>
              {t('quick_open.retry')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          // a11y(A56,CommandPalette 兄弟):焦点锁搜索框,输入致结果空时须 live region 播报无匹配。
          <>
            <div role="status" className="px-3 py-4 text-center text-xs text-fg-dim">
              {liveResults.length === 0 ? t('quick_open.empty') : t('quick_open.no_match')}
            </div>
            {limitHint}
          </>
        ) : (
          <>
            <ul
              {...listboxProps}
              aria-label={t('quick_open.list_aria')}
            >
              {virtualItems.map((vRow) => {
                const idx = vRow.index;
                const f = filtered[idx]!;
                const dir = dirname(f.relPath);
                const hl = matchHighlights(scores.get(f));
                return (
                  <li
                    key={f.absPath}
                    {...getOptionProps(vRow)}
                    // 键盘 selectedIndex 走选中样式(accent 底 + 左竖条),独立于鼠标 hover;最近打开之后的首行加分隔线
                    className={
                      recentCount > 0 && idx === recentCount
                        ? `${pickerRowClassName(idx === selectedIndex)} border-t border-t-line`
                        : pickerRowClassName(idx === selectedIndex)
                    }
                    title={f.relPath}
                    onClick={() => void openFile(f)}
                  >
                    {/* 文件名优先(VSCode Quick Open 同款):名称不收缩(上限 60%);右栏只放所在目录(不重复文件名,
                        否则前截断后只剩文件名尾巴、目录信息全丢),占剩余宽度并从前截断保留靠近文件的目录;
                        根下文件无目录则不渲染。完整相对路径在 title。 */}
                    <span className="max-w-[60%] shrink-0 truncate font-medium">
                      {highlightMatches(f.name, hl.name)}
                    </span>
                    {dir !== '' && (
                      <TruncateStart
                        text={dir}
                        title={f.relPath}
                        className={`min-w-0 flex-1 text-2xs ${pickerRowSecondaryClassName(idx === selectedIndex)}`}
                      >
                        {highlightMatches(dir, hl.dir)}
                      </TruncateStart>
                    )}
                    {recentCount > 0 && idx === 0 && (
                      <span className={`ml-auto shrink-0 pl-2 text-2xs ${pickerRowSecondaryClassName(idx === selectedIndex)}`}>
                        {recentLabel}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {limitHint}
          </>
        )}
      </div>
    </div>
  );
}
