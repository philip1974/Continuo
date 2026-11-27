// 代码编辑器右键菜单的追加项(对齐 VSCode 编辑器右键菜单 MenuId.EditorContext,无语言服务时):
//   更改所有匹配项 ⌘F2 / 格式化文档 ⇧⌥F(只在有格式化程序的文档上:JSON)/ ─ / 剪切 / 复制 / 粘贴 / ─ / 命令面板...
// renderer(CodeMirror 的 contextmenu 观察者)在所在文档的 <html> 上打标记,main 处理 webContents 'context-menu' 时向触发右键的
// frame 读出并清除标记(DOM 事件先于原生菜单请求,顺序有保证;popout 子窗的 DOM 在子窗文档里,标记随之在子窗)。
// BDD: src/__tests__/edit-context-menu/

export const EDITOR_CONTEXT_MENU_ATTR = 'data-co-editor-context-menu';

/** code = 代码编辑器 / Markdown 源码模式;code-format = 另有格式化程序(格式化文档项)。 */
export const EDITOR_CONTEXT_MENU_KINDS = ['code', 'code-format'] as const;
export type EditorContextMenuKind = (typeof EDITOR_CONTEXT_MENU_KINDS)[number];

export function isEditorContextMenuKind(v: unknown): v is EditorContextMenuKind {
  return typeof v === 'string' && (EDITOR_CONTEXT_MENU_KINDS as readonly string[]).includes(v);
}

/** main 在触发右键的 frame 里执行:读出并清除标记(常量脚本,不拼接任何外部输入)。 */
export const READ_EDITOR_CONTEXT_MENU_SCRIPT = `(() => { const d = document.documentElement; const v = d.getAttribute(${JSON.stringify(
  EDITOR_CONTEXT_MENU_ATTR,
)}); d.removeAttribute(${JSON.stringify(EDITOR_CONTEXT_MENU_ATTR)}); return v; })()`;
