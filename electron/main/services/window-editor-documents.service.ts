// 每窗口「经编辑器读取通道(fs:read-file)打开过的 Markdown 文档」登记(main 自己记账,不信 renderer 自报)。
// 用途:fs:read-image 对工作区外的 Markdown 文档放行其所在目录内的图片(对齐 VSCode markdown 预览:文档不属工作区时
// 文档目录进 localResourceRoots)。只有本窗口确实读过的文档才算 —— renderer 随便报一个 documentPath 不能扩大可读范围。
// 窗口关闭清空(window.ipc 的 closed 钩子);每窗口有上限,超出按登记先后淘汰最早的(防无界增长)。
// BDD: src/__tests__/editor-image-preview/

/** 每窗口最多登记的文档数(远超同时打开的 Markdown tab 数)。 */
export const EDITOR_DOCUMENTS_PER_WINDOW_MAX = 256;

const MARKDOWN_EXT = /\.(?:md|markdown)$/i;

const docsByWindow = new Map<number, Set<string>>();

/** 路径是否 Markdown 文档(与 renderer isMarkdownPath 同口径:.md / .markdown,不分大小写)。 */
export function isMarkdownDocumentPath(path: string): boolean {
  return MARKDOWN_EXT.test(path);
}

/** 登记 windowId 打开过的 Markdown 文档(非 Markdown 忽略)。重复登记刷新为最新。 */
export function recordEditorDocument(windowId: number, path: string): void {
  if (!isMarkdownDocumentPath(path)) return;
  let docs = docsByWindow.get(windowId);
  if (!docs) {
    docs = new Set();
    docsByWindow.set(windowId, docs);
  }
  docs.delete(path);
  docs.add(path);
  if (docs.size > EDITOR_DOCUMENTS_PER_WINDOW_MAX) {
    const oldest = docs.values().next().value;
    if (oldest !== undefined) docs.delete(oldest);
  }
}

/** path 是否 windowId 打开过的 Markdown 文档(按字面路径精确比较:renderer 传的是 tab 的路径,即当初读取的路径)。 */
export function isEditorDocument(windowId: number, path: string): boolean {
  return docsByWindow.get(windowId)?.has(path) ?? false;
}

export function clearWindow(windowId: number): void {
  docsByWindow.delete(windowId);
}

export function _reset(): void {
  docsByWindow.clear();
}
