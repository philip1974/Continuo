// Markdown 编辑 / 预览(Milkdown)查找条的入口:查找类命令(actions.find / nextMatchFindAction / previousMatchFindAction —— 按键、
// 菜单「编辑 → 查找」、命令面板)在活动 tab 不是 CodeMirror 时转到这里,与代码编辑器同经命令注册表分发(可改键)。
// MilkdownEditor 挂载时按「编辑器组 + tab」登记。
// 本模块在启动路径上(editor-text-commands 引用),不得静态 import Milkdown。
// BDD: src/__tests__/editor-find-keybindings/

/** 一个 Markdown 编辑器的查找入口。 */
export interface MarkdownFindHandle {
  /** 打开查找条(已打开则聚焦并全选查找词),同 ⌘F。 */
  open(): void;
  /** 查找下一个(1)/ 上一个(-1),同 ⌘G / ⇧⌘G / F3 / ⇧F3。 */
  step(direction: 1 | -1): void;
}

const handles = new Map<string, MarkdownFindHandle>();

const keyOf = (tabId: string, groupId: string): string => `${groupId}\u0000${tabId}`;

/** 登记(同组同 tab 后登记者取代先登记者);返回注销函数。 */
export function registerMarkdownFind(tabId: string, groupId: string, handle: MarkdownFindHandle): () => void {
  const key = keyOf(tabId, groupId);
  handles.set(key, handle);
  return () => {
    if (handles.get(key) === handle) handles.delete(key);
  };
}

/** 该 tab 的 Markdown 查找入口;没有登记(不是 Markdown 编辑 / 预览)→ undefined。 */
export function markdownFindOf(tabId: string, groupId: string): MarkdownFindHandle | undefined {
  return handles.get(keyOf(tabId, groupId));
}
