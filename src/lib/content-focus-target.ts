/**
 * 面板内容里优先接焦点的落点:CodeMirror / ProseMirror 的 contenteditable、输入框;data-editor-focus-target 是
 * 不可编辑但自身是编辑区落点的视图(只读图片预览)。点 dock tab / 编辑器 tab、F6、关闭后回落共用同一份(此前两处
 * 各写一遍,图片预览只补进了一处)。
 */
export const CONTENT_FOCUS_TARGET_SELECTOR =
  '[contenteditable="true"], textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), [data-editor-focus-target]';
