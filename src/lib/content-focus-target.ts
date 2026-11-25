/**
 * 面板内容里优先接焦点的落点:CodeMirror / ProseMirror 的 contenteditable、输入框;data-editor-focus-target 是
 * 不可编辑但自身是编辑区落点的视图(只读图片预览)。点 dock tab / 编辑器 tab、F6、关闭后回落共用同一份(此前两处
 * 各写一遍,图片预览只补进了一处)。
 */
export const CONTENT_FOCUS_TARGET_SELECTOR =
  '[contenteditable="true"], textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), [data-editor-focus-target]';

// 编辑器自己的聚焦方式,按其可编辑 DOM 登记。ProseMirror 的可编辑区被直接 DOM focus() 时,Chromium 把 DOM 选区放到
// 文档开头,ProseMirror 随后的 DOM 观察把它当作「聚焦重置了选区」:改回自己的选区并 scrollToSelection —— 切回 tab /
// 重启后刚恢复的滚动位置被拉回光标处。经 view.focus() 聚焦则先同步好 DOM 选区,不走这条路(VSCode:恢复保存时的视口,
// 聚焦不跳到光标)。BDD: src/__tests__/focus-keeps-scroll/
const focusHandlers = new WeakMap<Element, () => void>();

/** 编辑器视图就绪时把自己的聚焦方式登记到其可编辑 DOM 上;返回注销函数。 */
export function setContentFocusHandler(el: Element, focus: () => void): () => void {
  focusHandlers.set(el, focus);
  return () => {
    if (focusHandlers.get(el) === focus) focusHandlers.delete(el);
  };
}

/** 把焦点交给面板内容的落点:登记了编辑器自己的聚焦 → 用它;否则 focus({ preventScroll: true })(不滚动)。 */
export function focusContentTarget(el: HTMLElement): void {
  const focus = focusHandlers.get(el);
  if (focus) focus();
  else el.focus({ preventScroll: true });
}
