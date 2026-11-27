// 按「编辑器组 + tab」保留编辑器视图状态(VSCode EditorMemento:每个组各自保留每个文件的光标、滚动与折叠;切 tab /
// 重命名 / 切模式不丢)。BDD: src/__tests__/editor-view-state/、src/__tests__/editor-view-state-groups/
//
// 编辑器按 tab 卸载 / 重挂(EditorPanel 的 key),视图状态在卸载时存这里、重挂时取回:
//   - CodeMirror:整个 EditorState(文档 + 选区 + 撤销历史 / 折叠 state field)+ 滚动快照(scrollSnapshot)
//   - Milkdown:只存滚动位置(撤销历史在 ProseMirror 插件 state 里,跨 Crepe 实例重建不复用)
//   - Markdown 切模式锚点:视图卸载时记下顶部可见的源码行与光标所在行(带模式);另一模式的视图挂载时取用一次,
//     滚到同一位置(VSCode:Markdown 预览与源码按行同步)。同模式重挂(切 tab 回来 / 外部修改重载)不取用,
//     仍按上面各自的视图状态恢复。BDD: src/__tests__/markdown-mode-position/
//   - 图片预览:缩放比例与滚动位置(VSCode imagePreview 的 webview state)
//   - 跨重启(VSCode 持久化每个编辑器的视图状态):会话快照经 persistedEditorViewStateOf 取各组各 tab 的可序列化摘要
//     (选区 / 顶部可见行 / 折叠区域 / Markdown 滚动 / 图片缩放);恢复时 seedPersistedEditorViewState 回填 ——
//     Markdown 滚动与图片状态直接进各自的表,CodeMirror 摘要进 codeSeeds,只在该组该 tab 首次挂载(无本会话状态)时
//     取用一次。BDD: src/__tests__/editor-state-restart/
//
// 键 = 组 id + tab id:同一文件在两个组各有一份,互不覆盖。旧快照 / 不分组的条目记在「任意组」键下,作为各组的回退值
//(VSCode loadEditorState 的 fallbackToOtherGroupState 同理);新挂进某组、该组本会话无状态时也回退到别的组最近的状态
//(把 tab 拖到另一组时光标随之过去)。
// 条目随 tab 关闭删除、随重命名迁移、随组关闭删除(editor.store 调用);最多保留 CODE_EDITOR_VIEW_STATE_LIMIT 个(最久未用先淘汰)。
// 关闭时有撤销历史的 CodeMirror 状态另按路径留存,重新打开且内容未变时恢复撤销栈(见下「关闭文件的撤销历史」)。
// 本模块不 import editor.store(store 反向调用这里)。

import { redoDepth, undoDepth } from '@codemirror/commands';
import { ensureSyntaxTree, foldable, foldedRanges, foldEffect } from '@codemirror/language';
import type { EditorState, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';
import { EDITOR_VIEW_FOLDS_MAX } from '../../../electron/shared/explorer-persistence-schema';

export const CODE_EDITOR_VIEW_STATE_LIMIT = 50;

export interface CodeEditorViewState {
  readonly state: EditorState;
  /** view.scrollSnapshot():按文档位置记录的滚动锚点,新视图创建时经 `scrollTo` 恢复(超出新文档时自动收进范围)。 */
  readonly scroll: StateEffect<unknown>;
  /** 顶部可见行(1 起;跨重启摘要用)。 */
  readonly topLine: number;
}

/** 一个折叠区域(文档偏移,同 foldedRanges)。 */
export interface FoldRange {
  readonly from: number;
  readonly to: number;
}

/** CodeMirror 视图状态的可序列化摘要(会话快照 / 重启恢复)。 */
export interface PersistedCodeViewState {
  readonly anchor: number;
  readonly head: number;
  readonly topLine: number;
  readonly folds?: readonly FoldRange[];
}

/** 图片预览视图状态('fit' = 适应编辑区)。 */
export interface ImageViewState {
  readonly scale: 'fit' | number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/** 一个 tab 的可序列化视图状态(各部分按视图种类出现)。 */
export interface PersistedEditorViewState {
  readonly selection?: { readonly anchor: number; readonly head: number };
  readonly topLine?: number;
  readonly folds?: readonly FoldRange[];
  readonly scrollTop?: number;
  readonly image?: ImageViewState;
}

export type MarkdownViewMode = 'edit' | 'source' | 'preview';

export interface MarkdownModeAnchor {
  /** 记下锚点的视图模式。 */
  readonly mode: MarkdownViewMode;
  /** 顶部可见的源码行(1 起)。 */
  readonly topLine: number;
  /** 光标所在源码行(1 起;只读预览无光标)。 */
  readonly cursorLine?: number;
}

const codeStates = new Map<string, CodeEditorViewState>();
const markdownScrolls = new Map<string, number>();
const modeAnchors = new Map<string, MarkdownModeAnchor>();
const imageStates = new Map<string, ImageViewState>();
const codeSeeds = new Map<string, PersistedCodeViewState>();
const ALL_MAPS: readonly Map<string, unknown>[] = [codeStates, markdownScrolls, modeAnchors, imageStates, codeSeeds];

// 「任意组」:旧快照 / 单组时写的不分组条目,各组都可取用。组 id 形如 `editor` / `editor:2`,不会是空串。
const ANY_GROUP = '';
const SEP = '\u0000';

function keyOf(groupId: string, tabId: string): string {
  return `${groupId}${SEP}${tabId}`;
}

function tabOfKey(key: string): string {
  return key.slice(key.indexOf(SEP) + 1);
}

function groupOfKey(key: string): string {
  return key.slice(0, key.indexOf(SEP));
}

/** 别的组里该 tab 最近存入的值(插入序即最近使用序;不取出)。 */
function latestInOtherGroup<V>(map: Map<string, V>, tabId: string, groupId: string): V | undefined {
  let found: V | undefined;
  for (const [key, value] of map) {
    const g = groupOfKey(key);
    if (g !== groupId && g !== ANY_GROUP && tabOfKey(key) === tabId) found = value;
  }
  return found;
}

// 视图状态代际:任一视图状态可能变了(写入缓存 / 活动 CodeMirror 的选区或滚动变化)就递增。会话持久化据此判断关窗 /
// 退出时是否需要重取快照(光标 / 滚动太频繁,不调度防抖写)。
let viewStateGeneration = 0;

/** 活动编辑器的视图状态变了(选区 / 滚动)。 */
export function markEditorViewStateChanged(): void {
  viewStateGeneration += 1;
}

export function editorViewStateGeneration(): number {
  return viewStateGeneration;
}

/** Map 的插入序即最近使用序:写入时移到末尾,超上限淘汰最久未用的。 */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
  viewStateGeneration += 1;
  map.delete(key);
  map.set(key, value);
  if (map.size > CODE_EDITOR_VIEW_STATE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// ── 滚动快照 ─────────────────────────────────────────────

interface ScrollMemo {
  readonly scroll: StateEffect<unknown>;
  readonly topLine: number;
}

// 每个 CodeMirror 视图最近一次「已布局」时的滚动位置。视图未布局(所在面板隐藏 / 尚未显示,scrollDOM 高 0)时
// scrollTop 读作 0、创建时给的 scrollTo 也还没应用(CodeMirror 等到有高度才滚),此时按 scrollSnapshot() 会记成
// 「滚在文件顶部」而光标在原处 —— 重启 / 重挂后光标在视口外。未布局时改用这里记下的位置。
const lastLaidOutScroll = new WeakMap<EditorView, ScrollMemo>();

function liveScroll(view: EditorView): ScrollMemo {
  const { doc } = view.state;
  // 顶部可见行:滚过的内容高度(scrollTop 扣掉内容区上内边距)处的行;按已有高度信息算,不触发布局测量
  const height = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
  const from = view.lineBlockAtHeight(height).from;
  return { scroll: view.scrollSnapshot(), topLine: doc.lineAt(Math.min(Math.max(0, from), doc.length)).number };
}

function isLaidOut(view: EditorView): boolean {
  return view.scrollDOM.clientHeight > 0;
}

/** 视图创建时带了初始滚动(恢复的位置):在它真正应用(视图有高度)之前,快照按它记。 */
export function rememberInitialCodeEditorScroll(view: EditorView, scroll: StateEffect<unknown>, topLine: number): void {
  lastLaidOutScroll.set(view, { scroll, topLine });
}

/** 视图滚动了(scroll 事件):已布局时记下位置,供之后视图被隐藏时的快照使用。 */
export function noteCodeEditorScroll(view: EditorView): void {
  if (isLaidOut(view)) lastLaidOutScroll.set(view, liveScroll(view));
}

export function snapshotCodeEditorView(view: EditorView): CodeEditorViewState {
  if (isLaidOut(view)) {
    const memo = liveScroll(view);
    lastLaidOutScroll.set(view, memo);
    return { state: view.state, ...memo };
  }
  return { state: view.state, ...(lastLaidOutScroll.get(view) ?? liveScroll(view)) };
}

// ── 折叠 ─────────────────────────────────────────────────

/** 当前折叠区域(按位置,至多 EDITOR_VIEW_FOLDS_MAX 个);无 → undefined。 */
function foldsOf(state: EditorState): FoldRange[] | undefined {
  const out: FoldRange[] = [];
  const iter = foldedRanges(state).iter();
  for (; iter.value !== null && out.length < EDITOR_VIEW_FOLDS_MAX; iter.next()) out.push({ from: iter.from, to: iter.to });
  return out.length > 0 ? out : undefined;
}

/**
 * 上次会话的折叠区域 → 能在当前文档上原样折叠的那些的 foldEffect。区间须在文档范围内,且起点所在行此刻仍可折叠出同一区间
 *(文件在外部改过 / 语言尚未加载 → 丢弃该项,不抛)。按需推进语法解析到最后一个区间(至多 50ms)。
 */
export function restorableFoldEffects(state: EditorState, folds: readonly FoldRange[] | undefined): StateEffect<unknown>[] {
  if (!folds || folds.length === 0) return [];
  const len = state.doc.length;
  const valid = folds.filter((f) => Number.isInteger(f.from) && Number.isInteger(f.to) && f.from >= 0 && f.from < f.to && f.to <= len);
  if (valid.length === 0) return [];
  // 解析推进写在共享的解析上下文里;空事务让新 state 的语法树带上它(同 forceParsing)
  ensureSyntaxTree(state, Math.max(...valid.map((f) => f.to)), 50);
  const parsed = state.update({}).state;
  const effects: StateEffect<unknown>[] = [];
  for (const f of valid) {
    const line = parsed.doc.lineAt(f.from);
    const range = foldable(parsed, line.from, line.to);
    if (range && range.from === f.from && range.to === f.to) effects.push(foldEffect.of(range));
  }
  return effects;
}

// ── 会话内缓存(按组 + tab)────────────────────────────────

export function saveCodeEditorViewState(tabId: string, entry: CodeEditorViewState, groupId = PRIMARY_EDITOR_GROUP_ID): void {
  touch(codeStates, keyOf(groupId, tabId), entry);
}

/** 取出并移除本组的(视图卸载时会再存回最新状态)。 */
export function takeCodeEditorViewState(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): CodeEditorViewState | undefined {
  const key = keyOf(groupId, tabId);
  const entry = codeStates.get(key);
  codeStates.delete(key);
  return entry;
}

/** 别的组里该 tab 最近的会话内状态(该文件新挂进本组、本组没有任何状态时的回退;不取出)。 */
export function otherGroupCodeEditorViewState(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): CodeEditorViewState | undefined {
  return latestInOtherGroup(codeStates, tabId, groupId);
}

export function hasCodeEditorViewState(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): boolean {
  return codeStates.has(keyOf(groupId, tabId));
}

export function saveMarkdownScrollTop(tabId: string, scrollTop: number, groupId = PRIMARY_EDITOR_GROUP_ID): void {
  touch(markdownScrolls, keyOf(groupId, tabId), scrollTop);
}

export function markdownScrollTopOf(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): number | undefined {
  return markdownScrolls.get(keyOf(groupId, tabId)) ?? markdownScrolls.get(keyOf(ANY_GROUP, tabId));
}

export function saveMarkdownModeAnchor(tabId: string, anchor: MarkdownModeAnchor, groupId = PRIMARY_EDITOR_GROUP_ID): void {
  touch(modeAnchors, keyOf(groupId, tabId), anchor);
}

/** 取出并移除;锚点来自另一模式才返回(同模式重挂按该视图自己的状态恢复)。 */
export function takeMarkdownModeAnchor(
  tabId: string,
  mode: MarkdownViewMode,
  groupId = PRIMARY_EDITOR_GROUP_ID,
): MarkdownModeAnchor | undefined {
  const key = keyOf(groupId, tabId);
  const anchor = modeAnchors.get(key);
  modeAnchors.delete(key);
  return anchor !== undefined && anchor.mode !== mode ? anchor : undefined;
}

export function saveImageViewState(tabId: string, entry: ImageViewState, groupId = PRIMARY_EDITOR_GROUP_ID): void {
  touch(imageStates, keyOf(groupId, tabId), entry);
}

export function imageViewStateOf(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): ImageViewState | undefined {
  return imageStates.get(keyOf(groupId, tabId)) ?? imageStates.get(keyOf(ANY_GROUP, tabId));
}

/** 取出并移除上次会话留给本组的 CodeMirror 摘要(只在该组该 tab 首次挂载、本会话无状态时调用)。 */
export function takeCodeEditorSeed(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): PersistedCodeViewState | undefined {
  const key = keyOf(groupId, tabId);
  const seed = codeSeeds.get(key);
  codeSeeds.delete(key);
  return seed;
}

/** 上次会话不分组的 CodeMirror 摘要(旧数据 / 单组;各组的回退值,不取出)。 */
export function fallbackCodeEditorSeed(tabId: string): PersistedCodeViewState | undefined {
  return codeSeeds.get(keyOf(ANY_GROUP, tabId));
}

/** 会话恢复:把快照里该 tab 的视图状态回填到组 groupId(缺省 = 不分组:各组的回退值)。 */
export function seedPersistedEditorViewState(tabId: string, entry: PersistedEditorViewState, groupId: string = ANY_GROUP): void {
  const key = keyOf(groupId, tabId);
  if (entry.selection !== undefined) {
    codeSeeds.set(key, {
      ...entry.selection,
      topLine: entry.topLine ?? 1,
      ...(entry.folds === undefined ? null : { folds: entry.folds }),
    });
  }
  if (entry.scrollTop !== undefined) touch(markdownScrolls, key, entry.scrollTop);
  if (entry.image !== undefined) touch(imageStates, key, entry.image);
}

/**
 * 会话快照用:组 groupId 里该 tab 当前的可序列化视图状态。CodeMirror 优先取该组仍挂着的视图(liveView),其次本组的
 * 会话缓存,再次上次会话留下且尚未挂载过的摘要(本组的,或不分组的回退值)。无任何状态 → undefined。
 */
export function persistedEditorViewStateOf(
  tabId: string,
  liveView: EditorView | undefined,
  groupId = PRIMARY_EDITOR_GROUP_ID,
): PersistedEditorViewState | undefined {
  const key = keyOf(groupId, tabId);
  const cached = liveView ? snapshotCodeEditorView(liveView) : codeStates.get(key);
  let code: PersistedCodeViewState | undefined = codeSeeds.get(key) ?? codeSeeds.get(keyOf(ANY_GROUP, tabId));
  if (cached) {
    const { anchor, head } = cached.state.selection.main;
    const folds = foldsOf(cached.state);
    code = { anchor, head, topLine: cached.topLine, ...(folds ? { folds } : null) };
  }
  const scrollTop = markdownScrollTopOf(tabId, groupId);
  const image = imageViewStateOf(tabId, groupId);
  if (code === undefined && scrollTop === undefined && image === undefined) return undefined;
  return {
    ...(code
      ? {
          selection: { anchor: code.anchor, head: code.head },
          topLine: code.topLine,
          ...(code.folds && code.folds.length > 0 ? { folds: code.folds } : null),
        }
      : null),
    ...(scrollTop === undefined ? null : { scrollTop }),
    ...(image === undefined ? null : { image }),
  };
}

/**
 * tab 换 id(重命名 / 移动)时迁移视图状态(各组的都迁)。旧 id 的 CodeMirror 视图还挂着(重命名的提交还没渲染)时,
 * 直接按它的当前状态存到新 id 的同一组 —— 随后它以旧 id 卸载时 tab 已不存在、不再存入。
 */
export function renameEditorViewStates(
  pairs: ReadonlyArray<readonly [oldId: string, newId: string]>,
  liveViews: (oldId: string) => ReadonlyArray<{ readonly groupId: string; readonly view: EditorView }>,
): void {
  for (const [oldId, newId] of pairs) {
    for (const map of ALL_MAPS as readonly Map<string, unknown>[]) {
      for (const [key, value] of [...map]) {
        if (tabOfKey(key) !== oldId) continue;
        map.delete(key);
        const next = keyOf(groupOfKey(key), newId);
        if (map === codeSeeds) map.set(next, value);
        else touch(map, next, value);
      }
    }
    for (const { groupId, view } of liveViews(oldId)) touch(codeStates, keyOf(groupId, newId), snapshotCodeEditorView(view));
  }
}

/** 只保留仍打开的 tab 的视图状态(tab 关闭 / 移除后调用)。 */
export function retainEditorViewStates(isOpen: (tabId: string) => boolean): void {
  for (const map of ALL_MAPS) for (const key of [...map.keys()]) if (!isOpen(tabOfKey(key))) map.delete(key);
}

/** 丢弃已关闭的编辑器组的视图状态(VSCode:组移除时清掉该组的 editor memento)。 */
export function dropEditorViewStatesOfGroups(isGone: (groupId: string) => boolean): void {
  for (const map of ALL_MAPS) {
    for (const key of [...map.keys()]) {
      const g = groupOfKey(key);
      if (g !== ANY_GROUP && isGone(g)) map.delete(key);
    }
  }
}

// ── 关闭文件的撤销历史(VSCode files.restoreUndoStack,默认开)──────────
// VSCode ModelService:模型销毁(文件的最后一个编辑器关闭)时有撤销 / 重做元素就按 URI 留下(连同内容 SHA1),重新打开时内容
// SHA1 相同 → 恢复撤销栈,不同 → 丢弃;留存总量上限 MAX_MEMORY_FOR_CLOSED_FILES_UNDO_STACK = 20MB(超出淘汰最早关闭的),
// 超过 10MB 的模型不算 SHA1、不留。这里留整个 CodeMirror EditorState(文档 + 撤销历史 + 选区 / 折叠),重新打开时
// 「磁盘内容 = 留存的文档」才复用(CodeEditor restoreState 的同一比较),否则丢弃。按 tab id(= 路径)记;文件被删除 / 移走、
// 切换工作区根时作废(editor.store 调用)。Markdown 编辑视图(Milkdown)的撤销历史跨实例不复用,不在此列。
// BDD: src/__tests__/editor-reopen-closed/

/** 关闭文件撤销历史的留存总量上限(按 UTF-16 文档字节估算;VSCode 20MB)。 */
export const CLOSED_UNDO_MEMORY_MAX = 20 * 1024 * 1024;
/** 超过此长度(UTF-16 code unit)的文档不留(VSCode DefaultModelSHA1Computer.MAX_MODEL_SIZE = 10MB)。 */
export const CLOSED_UNDO_DOC_MAX_CHARS = 10 * 1024 * 1024;

const closedStates = new Map<string, { readonly state: EditorState; readonly cost: number }>();
let closedCost = 0;

function dropClosed(tabId: string): void {
  const e = closedStates.get(tabId);
  if (!e) return;
  closedCost -= e.cost;
  closedStates.delete(tabId);
}

/** 文件的最后一个编辑器关闭:有撤销 / 重做历史就留下它的 EditorState(超限淘汰最早关闭的;过大的文档不留)。 */
export function stashClosedCodeEditorState(tabId: string, state: EditorState): void {
  dropClosed(tabId);
  if (undoDepth(state) === 0 && redoDepth(state) === 0) return;
  if (state.doc.length > CLOSED_UNDO_DOC_MAX_CHARS) return;
  const cost = state.doc.length * 2;
  for (const key of closedStates.keys()) {
    if (closedCost + cost <= CLOSED_UNDO_MEMORY_MAX) break;
    dropClosed(key);
  }
  if (closedCost + cost > CLOSED_UNDO_MEMORY_MAX) return;
  closedStates.set(tabId, { state, cost });
  closedCost += cost;
}

/** 重新打开时取出(并移除)关闭时留下的 EditorState;调用方比对内容,不同则丢弃。 */
export function takeClosedCodeEditorState(tabId: string): EditorState | undefined {
  const e = closedStates.get(tabId);
  dropClosed(tabId);
  return e?.state;
}

/** 作废 isGone(tabId) 为真的留存(文件删除 / 移走 / 切换工作区根)。 */
export function dropClosedCodeEditorStates(isGone: (tabId: string) => boolean): void {
  for (const key of [...closedStates.keys()]) if (isGone(key)) dropClosed(key);
}

/** 本会话该组该 tab 缓存的 CodeMirror 状态(不取出;tab 关闭时留存撤销历史用)。 */
export function cachedCodeEditorState(tabId: string, groupId = PRIMARY_EDITOR_GROUP_ID): EditorState | undefined {
  return codeStates.get(keyOf(groupId, tabId))?.state;
}

/** 测试用:清空。 */
export function clearEditorViewStates(): void {
  for (const map of ALL_MAPS) map.clear();
  closedStates.clear();
  closedCost = 0;
}
