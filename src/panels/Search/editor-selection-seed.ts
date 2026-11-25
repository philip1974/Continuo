// ⇧⌘F 带入查询的编辑器选区(VSCode search.seedWithNearestWord 关闭时的默认:只带选区,且只带单行)。
// 只认焦点在编辑区(CodeMirror / Milkdown 正文)时的原生选区:两个引擎在聚焦时都把选区同步到 DOM。不碰编辑器内部状态。
// BDD: src/__tests__/workspace-search/(第 1 条)

const EDITOR_ROOT_SELECTOR = '.cm-editor, .ProseMirror';

/** 焦点在编辑器且选区非空、单行 → 选区文本;否则 undefined。 */
export function editorSelectionSeed(doc: Document = document): string | undefined {
  const active = doc.activeElement;
  if (!active?.closest(EDITOR_ROOT_SELECTOR)) return undefined;
  const text = doc.getSelection()?.toString() ?? '';
  if (text === '' || /[\r\n]/.test(text)) return undefined;
  return text;
}
