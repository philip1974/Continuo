function isPathSeparatorCode(code: number): boolean {
  return code === 47 || code === 92;
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiCharCaseInsensitive(
  path: string,
  index: number,
  lowerCode: number,
): boolean {
  const code = path.charCodeAt(index);
  return code === lowerCode || code === lowerCode - 32;
}

export function isMarkdownPath(path: string): boolean {
  const len = path.length;
  if (len >= 3 && path.charCodeAt(len - 3) === 46) {
    return (
      isAsciiCharCaseInsensitive(path, len - 2, 109) &&
      isAsciiCharCaseInsensitive(path, len - 1, 100)
    );
  }
  if (len < 9 || path.charCodeAt(len - 9) !== 46) return false;
  return (
    isAsciiCharCaseInsensitive(path, len - 8, 109) &&
    isAsciiCharCaseInsensitive(path, len - 7, 97) &&
    isAsciiCharCaseInsensitive(path, len - 6, 114) &&
    isAsciiCharCaseInsensitive(path, len - 5, 107) &&
    isAsciiCharCaseInsensitive(path, len - 4, 100) &&
    isAsciiCharCaseInsensitive(path, len - 3, 111) &&
    isAsciiCharCaseInsensitive(path, len - 2, 119) &&
    isAsciiCharCaseInsensitive(path, len - 1, 110)
  );
}

function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 0 && isPathSeparatorCode(path.charCodeAt(end - 1))) {
    end -= 1;
  }
  return end === path.length ? path : path.slice(0, end);
}

// 跨平台绝对路径判定(renderer 无 node:path,手写)。
//   - POSIX:以 `/` 开头
//   - Windows 盘符:`C:\` 或 `C:/`(冒号后必须紧跟分隔符;`C:relative` 是盘符相对路径,不算绝对)
//   - Windows UNC:`\\server\share`
// 旧实现只判 `/`,导致 Windows 真实绝对路径(co-app editor.openFile 守卫)全被当相对 → 插件打不开本地文件。
export function isAbsolutePath(path: string): boolean {
  if (path.length === 0) return false;
  const first = path.charCodeAt(0);
  if (first === 47) return true; // POSIX
  if (first === 92) return path.charCodeAt(1) === 92; // UNC
  return (
    path.length >= 3 &&
    isAsciiAlphaCode(first) &&
    path.charCodeAt(1) === 58 &&
    isPathSeparatorCode(path.charCodeAt(2))
  );
}

/**
 * 可维护性 M12:非空文件路径 → 展示用 basename(吃 `/` 与 `\`,先 trim 尾部分隔符再取
 * 最后一段)。EditorPanel(tab 标题)与 EditorHeader 共用此规则;**null fallback 文案**
 * (draft / untitled)各调用方自行处理,故此 helper 只收非空 path。
 */
export function basenameForEditorPath(path: string): string {
  const trimmed = trimTrailingSeparators(path);
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
