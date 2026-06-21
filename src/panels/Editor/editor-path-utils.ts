export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/');
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
