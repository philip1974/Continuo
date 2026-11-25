// 按 tab 保留编辑器视图状态(VSCode:每个文件各自保留撤销栈、光标与滚动;切 tab / 重命名 / 切模式不丢)。
// BDD: src/__tests__/editor-view-state/
//
// 编辑器按 tab 卸载 / 重挂(EditorPanel 的 key),视图状态在卸载时存这里、重挂时取回:
//   - CodeMirror:整个 EditorState(文档 + 选区 + 撤销历史 state field)+ 滚动快照(scrollSnapshot)
//   - Milkdown:只存滚动位置(撤销历史在 ProseMirror 插件 state 里,跨 Crepe 实例重建不复用)
//   - Markdown 切模式锚点:视图卸载时记下顶部可见的源码行与光标所在行(带模式);另一模式的视图挂载时取用一次,
//     滚到同一位置(VSCode:Markdown 预览与源码按行同步)。同模式重挂(切 tab 回来 / 外部修改重载)不取用,
//     仍按上面各自的视图状态恢复。BDD: src/__tests__/markdown-mode-position/
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

/** Map 的插入序即最近使用序:写入时移到末尾,超上限淘汰最久未用的。 */
function touch<V>(map: Map<string, V>, key: string, value: V): void {
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
  }
}

/** 只保留仍打开的 tab 的视图状态(tab 关闭 / 移除后调用)。 */
export function retainEditorViewStates(isOpen: (tabId: string) => boolean): void {
  for (const id of [...codeStates.keys()]) if (!isOpen(id)) codeStates.delete(id);
  for (const id of [...markdownScrolls.keys()]) if (!isOpen(id)) markdownScrolls.delete(id);
  for (const id of [...modeAnchors.keys()]) if (!isOpen(id)) modeAnchors.delete(id);
}

/** 测试用:清空。 */
export function clearEditorViewStates(): void {
  codeStates.clear();
  markdownScrolls.clear();
  modeAnchors.clear();
}
