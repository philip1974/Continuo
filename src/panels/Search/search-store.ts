// 在文件中查找(workspace-search)的视图状态与搜索调度:查询 / 开关 / 包含排除 → 去抖 300ms(VSCode
// search.searchOnTypeDebouncePeriod)发起 main 搜索;新查询先取消在途查询,迟到的旧 searchId 事件丢弃;结果按文件分组累加。
// 状态放在模块级 store:面板关掉再开(⇧⌘F)仍保留上次查询与结果(VSCode 搜索视图同)。
// 已打开的编辑器在内存内容上搜(含未保存修改、不受大小上限),结果先显示并覆盖磁盘同一文件的结果(open-editor-search)。
// 文件删除 / 改名 / 移动(editor.store 路径变更通知)→ 其结果从列表移除(VSCode SearchView.onFilesChanged:删除的
// 文件移除匹配;移动 = 旧路径删除,新位置不自动补搜)。
// 查询 / 开关 / 包含排除 / 详情展开随 explorer.json 窗口段跨重启恢复(VSCode SearchView 视图状态),只恢复输入、不自动重搜
//(searchInputSnapshot / restoreSearchInput,由 explorer-persist 读写)。
// BDD: src/__tests__/workspace-search/

import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { clampSearchQuery, regexSyntaxError } from '@/lib/search-query';
import { openFileInEditor } from '@/plugins/co-app';
import { takeSideEditorGroup } from '@/shell/dock/explorer-editor-drop';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { onEditorPathChange, useEditorStore } from '@/stores/editor.store';
import { isSameOrInsidePath } from '@/lib/path-cross';
import { mergeDiskBatch, searchOpenEditors, searchOverrideKey, searchRelPath } from './open-editor-search';
import {
  buildSearchRegExp,
  searchRegExpFlags,
  searchRegExpSource,
  SEARCH_GLOB_MAX,
  type SearchEvent,
  type SearchFileResult,
  type SearchQuery,
} from '../../../electron/shared/workspace-search';
import type { PersistedSearchInput } from '../../../electron/shared/explorer-persistence-schema';
import { getStoredSettingValue } from '@/plugins/settings/values-store';
import { SEARCH_USE_IGNORE_FILES } from '@/plugins/settings/core-setting-specs';

/** 设置 search.useIgnoreFiles(发起搜索时读;未存值 → 默认开)。 */
function ignoreFilesSettingOn(): boolean {
  return (getStoredSettingValue(SEARCH_USE_IGNORE_FILES.id) ?? SEARCH_USE_IGNORE_FILES.default) !== false;
}

export const SEARCH_DEBOUNCE_MS = 300;

/** cancelled:用户取消了在途搜索(VSCode search.action.cancel),已收到的结果保留。 */
export type SearchStatus = 'idle' | 'searching' | 'done' | 'cancelled' | 'error' | 'invalid' | 'no-workspace';

/** 树行键:文件行 = 路径;匹配行 = `路径\0序号`。 */
export type SearchRowKey = string;
export const matchRowKey = (path: string, index: number): SearchRowKey => `${path}\0${index}`;

interface SearchState {
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly include: string;
  readonly exclude: string;
  /** 「使用排除设置与忽略文件」(VSCode 排除框内的开关,默认开):关 → 不用工作区排除表的构建产物目录与 .gitignore / .ignore。 */
  readonly useExcludesAndIgnoreFiles: boolean;
  readonly detailsOpen: boolean;
  readonly status: SearchStatus;
  readonly files: readonly SearchFileResult[];
  readonly resultCount: number;
  readonly limitHit: boolean;
  readonly filesLimitHit: boolean;
  /** 因超过 1 MiB 跳过且未在编辑器中打开的文件数(打开的已在内存里搜过)。 */
  readonly skippedLarge: number;
  /** 枚举时因无法读取(无权限 / 路径超长等)跳过的子目录数。 */
  readonly skippedUnreadable: number;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly collapsed: ReadonlySet<string>;
  /** 结果树当前行(键盘 / F4 共用)。 */
  readonly activeKey: SearchRowKey | null;
  /** 递增 → 面板把焦点交给查询框并全选(⇧⌘F)。 */
  readonly focusRequest: number;
  /** 面板已兑现到的 focusRequest(启动恢复 / 重挂载不重复聚焦)。 */
  readonly focusHandled: number;
  setPattern(pattern: string): void;
  toggleOption(option: 'isRegex' | 'matchCase' | 'wholeWord'): void;
  setInclude(include: string): void;
  setExclude(exclude: string): void;
  toggleUseExcludesAndIgnoreFiles(): void;
  toggleDetails(): void;
  toggleCollapsed(path: string, collapsed?: boolean): void;
  setActiveKey(key: SearchRowKey | null): void;
  /** 立即搜索(Enter)。 */
  searchNow(): void;
  /** 取消在途搜索(VSCode search.action.cancel:视图里的「取消搜索」/ 结果树 Esc);已收到的结果保留,状态 → cancelled。 */
  cancelSearch(): void;
  /** 清空包含 / 排除后立即重搜(VSCode「在所有文件中重新搜索」)。 */
  searchInAllFiles(): void;
  /** 聚焦查询框;seed 非空 → 替换查询(编辑器单行选区)。 */
  requestFocus(seed?: string): void;
}

const INITIAL = {
  pattern: '',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  useExcludesAndIgnoreFiles: true,
  detailsOpen: false,
  status: 'idle' as SearchStatus,
  files: [] as readonly SearchFileResult[],
  resultCount: 0,
  limitHit: false,
  filesLimitHit: false,
  skippedLarge: 0,
  skippedUnreadable: 0,
  error: null,
  collapsed: new Set<string>() as ReadonlySet<string>,
  activeKey: null,
  focusRequest: 0,
  focusHandled: 0,
};

let currentId: string | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | null = null;
/** 当前搜索的工作区根与已在内存里搜过的文件(覆盖键);合并截断标记。 */
let currentRoot = '';
let searchedInMemory: ReadonlySet<string> = new Set();
let mergedLimitHit = false;

export const useSearchStore = create<SearchState>((set, get) => ({
  ...INITIAL,
  setPattern: (pattern) => {
    set({ pattern: clampSearchQuery(pattern) });
    schedule();
  },
  toggleOption: (option) => {
    set((s) => ({ [option]: !s[option] }) as Pick<SearchState, typeof option>);
    schedule();
  },
  setInclude: (include) => {
    set({ include: include.slice(0, SEARCH_GLOB_MAX) });
    schedule();
  },
  setExclude: (exclude) => {
    set({ exclude: exclude.slice(0, SEARCH_GLOB_MAX) });
    schedule();
  },
  toggleUseExcludesAndIgnoreFiles: () => {
    set((s) => ({ useExcludesAndIgnoreFiles: !s.useExcludesAndIgnoreFiles }));
    schedule();
  },
  toggleDetails: () => set((s) => ({ detailsOpen: !s.detailsOpen })),
  toggleCollapsed: (path, collapsed) =>
    set((s) => {
      const has = s.collapsed.has(path);
      const next = collapsed ?? !has;
      if (next === has) return s;
      const c = new Set(s.collapsed);
      if (next) c.add(path);
      else c.delete(path);
      // 折叠后活动行若是其下的匹配行 → 回到文件行
      const activeKey = next && s.activeKey?.startsWith(`${path}\0`) ? path : s.activeKey;
      return { collapsed: c, activeKey };
    }),
  setActiveKey: (activeKey) => set({ activeKey }),
  searchNow: () => {
    clearTimeout(timer);
    timer = undefined;
    run();
  },
  cancelSearch: () => {
    if (currentId === null || get().status !== 'searching') return;
    cancelCurrent();
    set({ status: 'cancelled' });
  },
  searchInAllFiles: () => {
    set({ include: '', exclude: '' });
    get().searchNow();
  },
  requestFocus: (seed) => {
    set((s) => ({ focusRequest: s.focusRequest + 1 }));
    if (seed) get().setPattern(seed);
  },
}));

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    run();
  }, SEARCH_DEBOUNCE_MS);
}

function cancelCurrent(): void {
  if (currentId === null) return;
  const id = currentId;
  currentId = null;
  try {
    void coApi.search.cancel(id).catch(() => {});
  } catch {
    // 取消失败无需处理:迟到的事件按 searchId 丢弃
  }
}

const EMPTY_RESULTS = {
  files: [] as readonly SearchFileResult[],
  resultCount: 0,
  limitHit: false,
  filesLimitHit: false,
  skippedLarge: 0,
  skippedUnreadable: 0,
  error: null,
  activeKey: null,
  collapsed: new Set<string>() as ReadonlySet<string>,
};

function run(): void {
  cancelCurrent();
  const s = useSearchStore.getState();
  if (s.pattern === '') {
    useSearchStore.setState({ ...EMPTY_RESULTS, status: 'idle' });
    return;
  }
  if (s.isRegex && regexSyntaxError(searchRegExpSource(s), searchRegExpFlags(s.matchCase)) !== null) {
    useSearchStore.setState({ ...EMPTY_RESULTS, status: 'invalid' });
    return;
  }
  const root = useWorkspaceStore.getState().root;
  if (root === null) {
    useSearchStore.setState({ ...EMPTY_RESULTS, status: 'no-workspace' });
    return;
  }
  ensureSubscribed();
  seq += 1;
  const id = `search-${seq}`;
  currentId = id;
  const query: SearchQuery = {
    pattern: s.pattern,
    isRegex: s.isRegex,
    matchCase: s.matchCase,
    wholeWord: s.wholeWord,
    include: s.include,
    exclude: s.exclude,
    // VSCode QueryBuilder:disregardIgnoreFiles = !useExcludesAndIgnoreFiles || !search.useIgnoreFiles
    ...(!s.useExcludesAndIgnoreFiles || !ignoreFilesSettingOn() ? { disregardIgnoreFiles: true } : null),
    ...(s.useExcludesAndIgnoreFiles ? null : { disregardExcludeSettings: true }),
  };
  // 已打开编辑器:内存内容上先搜(只读 editor.store),结果先显示;main 推来的同一文件结果在 applyEvent 里丢弃。
  const local = searchOpenEditors(useEditorStore.getState().tabs, root, query, buildSearchRegExp(query));
  currentRoot = root;
  searchedInMemory = local.searched;
  mergedLimitHit = local.limitHit;
  useSearchStore.setState({ ...EMPTY_RESULTS, status: 'searching', files: local.files, resultCount: local.resultCount });
  const failed = (err: unknown) => fail(id, 'EXCEPTION', err instanceof Error ? err.message : String(err));
  try {
    coApi.search.start(id, query).then((r) => {
      if (!r.ok) fail(id, r.code, r.message);
    }, failed);
  } catch (err) {
    failed(err);
  }
}

function fail(id: string, code: string, message: string): void {
  if (currentId !== id) return;
  currentId = null;
  useSearchStore.setState({ status: 'error', error: { code, message } });
}

function ensureSubscribed(): void {
  if (unsubscribe !== null) return;
  unsubscribe = coApi.search.onEvent(applyEvent);
}

function applyEvent(e: SearchEvent): void {
  if (e.searchId !== currentId) return; // 已取消 / 被新查询取代
  if (e.kind === 'files') {
    if (mergedLimitHit) return; // 总数已达上限(内存 + 磁盘合并口径)
    useSearchStore.setState((s) => {
      const merged = mergeDiskBatch(e.files, searchedInMemory, s.resultCount);
      if (merged.limitHit) mergedLimitHit = true;
      if (merged.files.length === 0) return s;
      return { files: s.files.concat(merged.files), resultCount: s.resultCount + merged.added };
    });
    return;
  }
  currentId = null;
  if (e.kind === 'error') {
    useSearchStore.setState({ status: 'error', error: { code: e.code, message: e.message } });
    return;
  }
  // 跳过的大文件里已在编辑器中打开的,已在内存里搜过,不计入提示(路径列表有上限,超出部分按总数计)。
  let skippedLarge = e.skippedLargeCount ?? 0;
  for (const p of e.skippedLargePaths ?? []) {
    const rel = searchRelPath(currentRoot, p);
    if (rel !== null && searchedInMemory.has(searchOverrideKey(rel))) skippedLarge -= 1;
  }
  useSearchStore.setState({
    status: 'done',
    limitHit: e.limitHit || mergedLimitHit,
    filesLimitHit: e.filesLimitHit,
    skippedLarge: Math.max(0, skippedLarge),
    skippedUnreadable: e.skippedUnreadableDirs ?? 0,
  });
}

/** 移除 isGone(path) 为真的文件结果(计数 / 折叠 / 活动行一并修正);无命中不写 store。 */
function dropResultFiles(isGone: (path: string) => boolean): void {
  useSearchStore.setState((s) => {
    const files = s.files.filter((f) => !isGone(f.path));
    if (files.length === s.files.length) return s;
    let resultCount = 0;
    for (const f of files) resultCount += f.matches.length;
    const kept = new Set(files.map((f) => f.path));
    const collapsed = new Set([...s.collapsed].filter((p) => kept.has(p)));
    const activePath = s.activeKey === null ? null : s.activeKey.split('\0')[0]!;
    const activeKey = activePath !== null && kept.has(activePath) ? s.activeKey : null;
    return { files, resultCount, collapsed, activeKey };
  });
}

/** 结果树可见行键(文件行 + 未折叠文件的匹配行,与视图同序)。 */
export function visibleSearchRowKeys(files: readonly SearchFileResult[], collapsed: ReadonlySet<string>): SearchRowKey[] {
  const keys: SearchRowKey[] = [];
  for (const f of files) {
    keys.push(f.path);
    if (collapsed.has(f.path)) continue;
    for (let i = 0; i < f.matches.length; i += 1) keys.push(matchRowKey(f.path, i));
  }
  return keys;
}

/** 行键 → 文件路径与匹配序号(文件行 index = null)。 */
function parseRowKey(key: SearchRowKey): { path: string; index: number | null } {
  const at = key.indexOf('\0');
  return at < 0 ? { path: key, index: null } : { path: key.slice(0, at), index: Number(key.slice(at + 1)) };
}

/**
 * 右键「移除」(VSCode search.action.remove「Dismiss」):文件行 → 移除该文件全部结果;匹配行 → 移除该匹配(文件不剩匹配则
 * 连文件一起移除)。计数随之更新;活动行移到被移除行原位置上的下一行(没有则最后一行)。
 */
export function dismissSearchResult(key: SearchRowKey): void {
  useSearchStore.setState((s) => {
    const { path, index } = parseRowKey(key);
    const file = s.files.find((f) => f.path === path);
    if (!file || (index !== null && !file.matches[index])) return s;
    const before = visibleSearchRowKeys(s.files, s.collapsed);
    const at = before.indexOf(key);
    const keepFile = index !== null && file.matches.length > 1;
    const files = keepFile
      ? s.files.map((f) => (f === file ? { ...f, matches: f.matches.filter((_, i) => i !== index) } : f))
      : s.files.filter((f) => f !== file);
    const collapsed = keepFile || !s.collapsed.has(path) ? s.collapsed : new Set([...s.collapsed].filter((p) => p !== path));
    const after = visibleSearchRowKeys(files, collapsed);
    const activeKey = after.length === 0 ? null : after[Math.min(Math.max(at, 0), after.length - 1)]!;
    return { files, resultCount: s.resultCount - (index === null ? file.matches.length : 1), collapsed, activeKey };
  });
}

/** VSCode extractSearchFilePattern:`a.test.ts` → `*.test.ts`;无扩展名 → 文件名本身。 */
export function fileTypePattern(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length <= 1 ? fileName : `*.${parts.slice(1).join('.')}`;
}

/**
 * 右键「从搜索中排除 / 在搜索中包含文件类型」(VSCode modifySearchFileTypePattern):把该文件的类型 glob 追加到排除 / 包含框
 *(已有则不动),展开详情并立即重搜。
 */
export function addFileTypeToSearch(file: SearchFileResult, kind: 'include' | 'exclude'): void {
  const s = useSearchStore.getState();
  const name = file.relPath.slice(file.relPath.lastIndexOf('/') + 1);
  const pattern = fileTypePattern(name);
  const current = kind === 'include' ? s.include : s.exclude;
  const existing = current.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (existing.includes(pattern)) return;
  const next = current.trim() === '' ? pattern : `${current}, ${pattern}`;
  if (kind === 'include') s.setInclude(next);
  else s.setExclude(next);
  if (!useSearchStore.getState().detailsOpen) s.toggleDetails();
  s.searchNow();
}

onEditorPathChange((c) => {
  if (c.kind === 'moved') dropResultFiles((p) => isSameOrInsidePath(c.oldPath, p));
  else dropResultFiles((p) => c.paths.some((r) => isSameOrInsidePath(r, p)));
});

/**
 * 工作区切换:旧结果作废,按当前查询重搜。还没搜过(查询为空 / 重启恢复出的输入,status 都是 idle)且无在途查询 → 不搜
 *(恢复输入不自动重搜;去抖中的输入由其定时器照常搜)。
 */
export function rerunSearch(): void {
  if (useSearchStore.getState().status === 'idle' && currentId === null) return;
  useSearchStore.getState().searchNow();
}

/**
 * 打开某个匹配并选中它(失败统一提示;列 / 长度均为 UTF-16,与编辑器同一单位)。preview:单击 / F4 以预览方式打开(VSCode;
 * 双击 / Enter 常驻,BDD: src/__tests__/editor-preview-tab/)。groupId:打开到该编辑器组(在侧边打开,见 openSearchMatchToSide)。
 */
export function openSearchMatch(file: SearchFileResult, index: number, preview = false, groupId?: string): Promise<boolean> {
  const m = file.matches[index];
  if (!m) return Promise.resolve(false);
  const name = file.relPath.slice(file.relPath.lastIndexOf('/') + 1) || file.relPath;
  const openOpts = groupId === undefined ? { preview } : { preview, groupId };
  return openFileOrNotify(
    () => openFileInEditor(file.path, { line: m.line, column: m.column, length: m.length }, openOpts),
    name,
  );
}

/**
 * 在侧边打开匹配(VSCode search.action.openResultToSide,mac ⌃Enter、其它 Ctrl+Enter:常驻、侧边组获焦;右边没有编辑器组就
 * 向右拆出新组)。BDD: src/__tests__/open-to-side-from-pickers/
 */
export function openSearchMatchToSide(file: SearchFileResult, index: number): Promise<boolean> {
  if (!file.matches[index]) return Promise.resolve(false);
  return openSearchMatch(file, index, false, takeSideEditorGroup());
}

/**
 * F4 / ⇧F4(VSCode search.action.focusNext/PreviousSearchResult):活动行移到下 / 上一个匹配(循环、跨文件),并以预览方式
 * 打开它(VSCode searchView.selectNext/PreviousMatch 用 getSelectionKeyboardEvent(undefined, false, false) 选中 → pinned=false)。
 */
export async function focusNextSearchResult(delta: 1 | -1): Promise<void> {
  const s = useSearchStore.getState();
  const all: { file: SearchFileResult; index: number }[] = [];
  for (const file of s.files) for (let i = 0; i < file.matches.length; i += 1) all.push({ file, index: i });
  if (all.length === 0) return;
  let at = all.findIndex((r) => matchRowKey(r.file.path, r.index) === s.activeKey);
  if (at < 0) {
    // 活动行是文件行(或无):下一个 = 该文件第一个匹配,上一个 = 前一个文件的最后一个匹配
    const fileAt = s.activeKey === null ? -1 : all.findIndex((r) => r.file.path === s.activeKey);
    at = fileAt < 0 ? (delta > 0 ? -1 : 0) : delta > 0 ? fileAt - 1 : fileAt;
  }
  const next = all[(at + delta + all.length) % all.length]!;
  if (s.collapsed.has(next.file.path)) s.toggleCollapsed(next.file.path, false);
  useSearchStore.setState({ activeKey: matchRowKey(next.file.path, next.index) });
  await openSearchMatch(next.file, next.index, true);
}

/** 持久化的搜索输入(只含非默认项;全部默认 → null,窗口段不写该字段)。 */
export function searchInputSnapshot(): PersistedSearchInput | null {
  const s = useSearchStore.getState();
  if (
    s.pattern === '' &&
    !s.isRegex &&
    !s.matchCase &&
    !s.wholeWord &&
    s.include === '' &&
    s.exclude === '' &&
    s.useExcludesAndIgnoreFiles &&
    !s.detailsOpen
  ) {
    return null;
  }
  return {
    pattern: s.pattern,
    ...(s.isRegex ? { isRegex: true } : null),
    ...(s.matchCase ? { matchCase: true } : null),
    ...(s.wholeWord ? { wholeWord: true } : null),
    ...(s.include === '' ? null : { include: s.include }),
    ...(s.exclude === '' ? null : { exclude: s.exclude }),
    ...(s.useExcludesAndIgnoreFiles ? null : { useExcludesAndIgnoreFiles: false }),
    ...(s.detailsOpen ? { detailsOpen: true } : null),
  };
}

/** 重启恢复搜索输入:只回填输入,不发起搜索(结果保持空,status idle);缺省(旧数据)→ 保持当前(空)输入。 */
export function restoreSearchInput(input: PersistedSearchInput | undefined): void {
  if (input === undefined) return;
  useSearchStore.setState({
    pattern: clampSearchQuery(input.pattern),
    isRegex: input.isRegex === true,
    matchCase: input.matchCase === true,
    wholeWord: input.wholeWord === true,
    include: (input.include ?? '').slice(0, SEARCH_GLOB_MAX),
    exclude: (input.exclude ?? '').slice(0, SEARCH_GLOB_MAX),
    useExcludesAndIgnoreFiles: input.useExcludesAndIgnoreFiles !== false,
    detailsOpen: input.detailsOpen === true,
  });
}

export function __resetSearchForTest(): void {
  clearTimeout(timer);
  timer = undefined;
  currentId = null;
  seq = 0;
  currentRoot = '';
  searchedInMemory = new Set();
  mergedLimitHit = false;
  unsubscribe?.();
  unsubscribe = null;
  useSearchStore.setState({ ...INITIAL, collapsed: new Set() });
}
