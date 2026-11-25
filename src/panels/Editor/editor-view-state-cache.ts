// 按 tab 保留编辑器视图状态(VSCode:每个文件各自保留撤销栈、光标与滚动;切 tab / 重命名 / 切模式不丢)。
// BDD: src/__tests__/editor-view-state/
//
// 编辑器按 tab 卸载 / 重挂(EditorPanel 的 key),视图状态在卸载时存这里、重挂时取回:
//   - CodeMirror:整个 EditorState(文档 + 选区 + 撤销历史 state field)+ 滚动快照(scrollSnapshot)
//   - Milkdown:只存滚动位置(撤销历史在 ProseMirror 插件 state 里,跨 Crepe 实例重建不复用)
//   - Markdown 切模式锚点:视图卸载时记下顶部可见的源码行与光标所在行(带模式);另一模式的视图挂载时取用一次,
//     滚到同一位置(VSCode:Markdown 预览与源码按行同步)。同模式重挂(切 tab 回来 / 外部修改重载)不取用,
//     仍按上面各自的视图状态恢复。BDD: src/__tests__/markdown-mode-position/
//   - 图片预览:缩放比例与滚动位置(VSCode imagePreview 的 webview state)
//   - 跨重启(VSCode 持久化每个编辑器的视图状态):会话快照经 persistedEditorViewStateOf 取各 tab 的可序列化摘要
//     (选区 / 顶部可见行 / Markdown 滚动 / 图片缩放);恢复时 seedPersistedEditorViewState 回填 —— Markdown 滚动与
//     图片状态直接进各自的表,CodeMirror 摘要进 codeSeeds,只在该 tab 首次挂载(无本会话状态)时取用一次。
//     BDD: src/__tests__/editor-state-restart/
// 条目随 tab 关闭删除、随重命名迁移(editor.store 调用);最多保留 CODE_EDITOR_VIEW_STATE_LIMIT 个(最久未用先淘汰)。
// 本模块不 import editor.store(store 反向调用这里)。

import type { EditorState, StateEffect } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export const CODE_EDITOR_VIEW_STATE_LIMIT = 50;

export interface CodeEditorViewState {
  readonly state: EditorState;
  /** view.scrollSnapshot():按文档位置记录的滚动锚点,新视图创建时经 `scrollTo` 恢复(超出新文档时自动收进范围)。 */
  readonly scroll: StateEffect<unknown>;
}

/** CodeMirror 视图状态的可序列化摘要(会话快照 / 重启恢复)。 */
export interface PersistedCodeViewState {
  readonly anchor: number;
  readonly head: number;
  readonly topLine: number;
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

export function snapshotCodeEditorView(view: EditorView): CodeEditorViewState {
  return { state: view.state, scroll: view.scrollSnapshot() };
}

/**
 * 滚动快照里的顶部可见行(1 起)。scrollSnapshot() 是「滚到顶部可见行行首 + 偏移」的 scrollIntoView 效果,其值
 *(ScrollTarget)的 range 即该行起点 —— 按已有高度信息算出,不触发布局测量(卸载 / 写快照时不强制回流)。
 * 形态不符(CodeMirror 内部变化)→ 1。
 */
function topLineOfScrollSnapshot(state: EditorState, scroll: StateEffect<unknown>): number {
  const from = (scroll.value as { range?: { from?: unknown } } | null)?.range?.from;
  if (typeof from !== 'number' || !Number.isFinite(from)) return 1;
  return state.doc.lineAt(Math.min(Math.max(0, from), state.doc.length)).number;
}

export function saveCodeEditorViewState(tabId: string, entry: CodeEditorViewState): void {
  touch(codeStates, tabId, entry);
}

/** 取出并移除(视图卸载时会再存回最新状态)。 */
export function takeCodeEditorViewState(tabId: string): CodeEditorViewState | undefined {
  const entry = codeStates.get(tabId);
  codeStates.delete(tabId);
  return entry;
}

export function hasCodeEditorViewState(tabId: string): boolean {
  return codeStates.has(tabId);
}

export function saveMarkdownScrollTop(tabId: string, scrollTop: number): void {
  touch(markdownScrolls, tabId, scrollTop);
}

export function markdownScrollTopOf(tabId: string): number | undefined {
  return markdownScrolls.get(tabId);
}

export function saveMarkdownModeAnchor(tabId: string, anchor: MarkdownModeAnchor): void {
  touch(modeAnchors, tabId, anchor);
}

/** 取出并移除;锚点来自另一模式才返回(同模式重挂按该视图自己的状态恢复)。 */
export function takeMarkdownModeAnchor(tabId: string, mode: MarkdownViewMode): MarkdownModeAnchor | undefined {
  const anchor = modeAnchors.get(tabId);
  modeAnchors.delete(tabId);
  return anchor !== undefined && anchor.mode !== mode ? anchor : undefined;
}

export function saveImageViewState(tabId: string, entry: ImageViewState): void {
  touch(imageStates, tabId, entry);
}

export function imageViewStateOf(tabId: string): ImageViewState | undefined {
  return imageStates.get(tabId);
}

/** 取出并移除上次会话留下的 CodeMirror 摘要(只在该 tab 首次挂载、本会话无状态时调用)。 */
export function takeCodeEditorSeed(tabId: string): PersistedCodeViewState | undefined {
  const seed = codeSeeds.get(tabId);
  codeSeeds.delete(tabId);
  return seed;
}

/** 会话恢复:把快照里该 tab 的视图状态回填。 */
export function seedPersistedEditorViewState(tabId: string, entry: PersistedEditorViewState): void {
  if (entry.selection !== undefined) {
    codeSeeds.set(tabId, { ...entry.selection, topLine: entry.topLine ?? 1 });
  }
  if (entry.scrollTop !== undefined) touch(markdownScrolls, tabId, entry.scrollTop);
  if (entry.image !== undefined) touch(imageStates, tabId, entry.image);
}

/**
 * 会话快照用:该 tab 当前的可序列化视图状态。CodeMirror 优先取仍挂着的视图(liveView),其次本会话缓存,再次上次会话
 * 留下且尚未挂载过的摘要。无任何状态 → undefined。
 */
export function persistedEditorViewStateOf(
  tabId: string,
  liveView: EditorView | undefined,
): PersistedEditorViewState | undefined {
  const cached = liveView ? snapshotCodeEditorView(liveView) : codeStates.get(tabId);
  let code: PersistedCodeViewState | undefined = codeSeeds.get(tabId);
  if (cached) {
    const { anchor, head } = cached.state.selection.main;
    code = { anchor, head, topLine: topLineOfScrollSnapshot(cached.state, cached.scroll) };
  }
  const scrollTop = markdownScrolls.get(tabId);
  const image = imageStates.get(tabId);
  if (code === undefined && scrollTop === undefined && image === undefined) return undefined;
  return {
    ...(code ? { selection: { anchor: code.anchor, head: code.head }, topLine: code.topLine } : null),
    ...(scrollTop === undefined ? null : { scrollTop }),
    ...(image === undefined ? null : { image }),
  };
}

/**
 * tab 换 id(重命名 / 移动)时迁移视图状态。旧 id 的 CodeMirror 视图还挂着(重命名的提交还没渲染)时,
 * 直接按它的当前状态存到新 id —— 随后它以旧 id 卸载时 tab 已不存在、不再存入。
 */
export function renameEditorViewStates(
  pairs: ReadonlyArray<readonly [oldId: string, newId: string]>,
  liveView: (oldId: string) => EditorView | undefined,
): void {
  for (const [oldId, newId] of pairs) {
    const view = liveView(oldId);
    const code = view ? snapshotCodeEditorView(view) : codeStates.get(oldId);
    codeStates.delete(oldId);
    if (code) touch(codeStates, newId, code);
    const scroll = markdownScrolls.get(oldId);
    markdownScrolls.delete(oldId);
    if (scroll !== undefined) touch(markdownScrolls, newId, scroll);
    const anchor = modeAnchors.get(oldId);
    modeAnchors.delete(oldId);
    if (anchor !== undefined) touch(modeAnchors, newId, anchor);
    const image = imageStates.get(oldId);
    imageStates.delete(oldId);
    if (image !== undefined) touch(imageStates, newId, image);
    const seed = codeSeeds.get(oldId);
    codeSeeds.delete(oldId);
    if (seed !== undefined) codeSeeds.set(newId, seed);
  }
}

/** 只保留仍打开的 tab 的视图状态(tab 关闭 / 移除后调用)。 */
export function retainEditorViewStates(isOpen: (tabId: string) => boolean): void {
  for (const map of ALL_MAPS) for (const id of [...map.keys()]) if (!isOpen(id)) map.delete(id);
}

/** 测试用:清空。 */
export function clearEditorViewStates(): void {
  for (const map of ALL_MAPS) map.clear();
}
