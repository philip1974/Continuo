// 在文件中查找(workspace-search)的视图状态与搜索调度:查询 / 开关 / 包含排除 → 去抖 300ms(VSCode
// search.searchOnTypeDebouncePeriod)发起 main 搜索;新查询先取消在途查询,迟到的旧 searchId 事件丢弃;结果按文件分组累加。
// 状态放在模块级 store:面板关掉再开(⇧⌘F)仍保留上次查询与结果(VSCode 搜索视图同)。
// 已打开的编辑器在内存内容上搜(含未保存修改、不受大小上限),结果先显示并覆盖磁盘同一文件的结果(open-editor-search)。
// BDD: src/__tests__/workspace-search/

import { create } from 'zustand';
import { coApi } from '@/lib/co-api';
import { clampSearchQuery, regexSyntaxError } from '@/lib/search-query';
import { coApp } from '@/plugins/co-app';
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useEditorStore } from '@/stores/editor.store';
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

export const SEARCH_DEBOUNCE_MS = 300;

export type SearchStatus = 'idle' | 'searching' | 'done' | 'error' | 'invalid' | 'no-workspace';

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
  readonly detailsOpen: boolean;
  readonly status: SearchStatus;
  readonly files: readonly SearchFileResult[];
  readonly resultCount: number;
  readonly limitHit: boolean;
  readonly filesLimitHit: boolean;
  /** 因超过 1 MiB 跳过且未在编辑器中打开的文件数(打开的已在内存里搜过)。 */
  readonly skippedLarge: number;
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
  toggleDetails(): void;
  toggleCollapsed(path: string, collapsed?: boolean): void;
  setActiveKey(key: SearchRowKey | null): void;
  /** 立即搜索(Enter)。 */
  searchNow(): void;
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
  detailsOpen: false,
  status: 'idle' as SearchStatus,
  files: [] as readonly SearchFileResult[],
  resultCount: 0,
  limitHit: false,
  filesLimitHit: false,
  skippedLarge: 0,
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
  });
}

/** 工作区切换:旧结果作废,按当前查询重搜(查询为空则只清空)。 */
export function rerunSearch(): void {
  if (useSearchStore.getState().pattern === '' && currentId === null) return;
  useSearchStore.getState().searchNow();
}

/** 打开某个匹配并选中它(编辑器公共 API,失败统一提示;列 / 长度均为 UTF-16,与编辑器同一单位)。 */
export function openSearchMatch(file: SearchFileResult, index: number): Promise<boolean> {
  const m = file.matches[index];
  if (!m) return Promise.resolve(false);
  const name = file.relPath.slice(file.relPath.lastIndexOf('/') + 1) || file.relPath;
  return openFileOrNotify(() => coApp.editor.openFile(file.path, { line: m.line, column: m.column, length: m.length }), name);
}

/** F4 / ⇧F4(VSCode search.action.focusNext/PreviousSearchResult):活动行移到下 / 上一个匹配(循环、跨文件),并打开它。 */
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
  await openSearchMatch(next.file, next.index);
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
