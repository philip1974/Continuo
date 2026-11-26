// Markdown 编辑 / 预览(Milkdown)查找条的打开入口:菜单「编辑 → 查找」、命令面板的「查找」(actions.find)在活动 tab 不是
// CodeMirror 时转到这里,效果同在该编辑器里按 ⌘F。MilkdownEditor 挂载时按「编辑器组 + tab」登记。
// 本模块在启动路径上(editor-text-commands 引用),不得静态 import Milkdown。
// BDD: src/__tests__/editor-find-keybindings/

const openers = new Map<string, () => void>();

const keyOf = (tabId: string, groupId: string): string => `${groupId}\u0000${tabId}`;

/** 登记(同组同 tab 后登记者取代先登记者);返回注销函数。 */
export function registerMarkdownFind(tabId: string, groupId: string, open: () => void): () => void {
  const key = keyOf(tabId, groupId);
  openers.set(key, open);
  return () => {
    if (openers.get(key) === open) openers.delete(key);
  };
}

/** 打开该 tab 的 Markdown 查找条;没有登记(不是 Markdown 编辑 / 预览)→ false。 */
export function openMarkdownFind(tabId: string, groupId: string): boolean {
  const open = openers.get(keyOf(tabId, groupId));
  open?.();
  return open !== undefined;
}
