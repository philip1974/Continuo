// 每窗口「经编辑器读取通道(fs:read-file)打开过的 Markdown 文档」登记(main 自己记账,不信 renderer 自报)。
// 用途:fs:read-image 对工作区外的 Markdown 文档放行其所在目录内的图片(对齐 VSCode markdown 预览:文档不属工作区时
// 文档目录进 localResourceRoots)。只有本窗口确实读过的文档才算 —— renderer 随便报一个 documentPath 不能扩大可读范围。
// 窗口关闭清空(window.ipc 的 closed 钩子);每窗口有上限,超出按登记先后淘汰最早的(防无界增长)。
// BDD: src/__tests__/editor-image-preview/
//
// 另记「经 fs:read-file 打开过的全部文件」(不限 Markdown):fs:watch-file 只对这些文件的父目录装 watcher(工作区外可见文件的
// 外部修改同步)—— renderer 随便报一个路径不能让 main 去 watch 任意目录。BDD: src/__tests__/external-sync-outside-workspace/

/** 每窗口最多登记的文档数(远超同时打开的 Markdown tab 数)。 */
export const EDITOR_DOCUMENTS_PER_WINDOW_MAX = 256;

const MARKDOWN_EXT = /\.(?:md|markdown)$/i;

/** 每窗口最多登记的已打开文件数(远超同时打开的 tab 数;每次读取刷新为最新,打开中的 tab 每次外部同步都会再读)。 */
export const EDITOR_FILES_PER_WINDOW_MAX = 1024;

const docsByWindow = new Map<number, Set<string>>();
const filesByWindow = new Map<number, Set<string>>();

function remember(map: Map<number, Set<string>>, windowId: number, path: string, max: number): void {
  let set = map.get(windowId);
  if (!set) {
    set = new Set();
    map.set(windowId, set);
  }
  set.delete(path);
  set.add(path);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/** 路径是否 Markdown 文档(与 renderer isMarkdownPath 同口径:.md / .markdown,不分大小写)。 */
export function isMarkdownDocumentPath(path: string): boolean {
  return MARKDOWN_EXT.test(path);
}

/** 登记 windowId 打开过的 Markdown 文档(非 Markdown 忽略)。重复登记刷新为最新。 */
export function recordEditorDocument(windowId: number, path: string): void {
  if (!isMarkdownDocumentPath(path)) return;
  remember(docsByWindow, windowId, path, EDITOR_DOCUMENTS_PER_WINDOW_MAX);
}

/** 登记 windowId 经编辑器读取通道读过的文件(任何类型)。重复登记刷新为最新。 */
export function recordEditorFile(windowId: number, path: string): void {
  remember(filesByWindow, windowId, path, EDITOR_FILES_PER_WINDOW_MAX);
}

/** path 是否 windowId 经编辑器读取通道读过的文件(按字面路径精确比较)。 */
export function isEditorFile(windowId: number, path: string): boolean {
  return filesByWindow.get(windowId)?.has(path) ?? false;
}

/** path 是否 windowId 打开过的 Markdown 文档(按字面路径精确比较:renderer 传的是 tab 的路径,即当初读取的路径)。 */
export function isEditorDocument(windowId: number, path: string): boolean {
  return docsByWindow.get(windowId)?.has(path) ?? false;
}

export function clearWindow(windowId: number): void {
  docsByWindow.delete(windowId);
  filesByWindow.delete(windowId);
}

export function _reset(): void {
  docsByWindow.clear();
  filesByWindow.clear();
}
