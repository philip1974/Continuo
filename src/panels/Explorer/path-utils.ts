// Explorer 跨平台路径 helper(可维护性 M4:消除四处复制的 dirname)。
//
// 不引 path-browserify:规则简单且要同时吃 `/` 与 `\`(Windows)。tree-config /
// FolderTree / drop-handlers / mutate-actions 曾各自手写同一段 dirname,路径边界
// 规则一改要同步四处易漂移 → 收敛到此单一来源。

/**
 * 跨平台 dirname:吃 `/` 与 `\`。先去尾部分隔符,取最后一个分隔符位置;
 * 无分隔符 → `''`(裸文件名);分隔符在 0 位(根下直接项)→ `'/'`。
 *
 * 例:`/a/b` → `/a`;`/a/b/` → `/a`;`/a` → `/`;`a` → `''`;`C:\\x\\y` → `C:\\x`。
 */
export function dirname(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  return trimmed.slice(0, idx) || '/';
}

/**
 * 跨平台 basename:**先去尾部分隔符**再取最后一段。`/a/b/` → `b`、`/a` → `a`。
 * tree-config(root entry name)/ ExplorerHeader(面包屑)用此 trim 语义。
 */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * 跨平台 basename 的**不 trim 尾部分隔符**变体(逐字保留 FolderTree 唯一名 picker 的
 * 既有行为):`/a/b/` → `''`(尾斜杠后空段)。与 basename 语义不同,故单独命名,避免
 * 调用处误用 trim 版而隐式改变批量重名 picker 行为。其输入均为无尾斜杠的 fs 路径,
 * 实际结果与 basename 一致,命名只为显式标差异。
 */
export function basenamePreserveTrailing(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
