export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

// 跨平台绝对路径判定(renderer 无 node:path,手写)。
//   - POSIX:以 `/` 开头
//   - Windows 盘符:`C:\` 或 `C:/`(冒号后必须紧跟分隔符;`C:relative` 是盘符相对路径,不算绝对)
//   - Windows UNC:`\\server\share`
// 旧实现只判 `/`,导致 Windows 真实绝对路径(co-app editor.openFile 守卫)全被当相对 → 插件打不开本地文件。
export function isAbsolutePath(path: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(path);
}

/**
 * 可维护性 M12:非空文件路径 → 展示用 basename(吃 `/` 与 `\`,先 trim 尾部分隔符再取
 * 最后一段)。EditorPanel(tab 标题)与 EditorHeader 共用此规则;**null fallback 文案**
 * (draft / untitled)各调用方自行处理,故此 helper 只收非空 path。
 */
export function basenameForEditorPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
