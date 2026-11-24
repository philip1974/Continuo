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

// 跨平台绝对路径判定的单一来源在 src/lib/path-cross(旧实现只判 `/`,Windows 真实绝对路径全被当相对)。
export { isAbsolutePath } from '@/lib/path-cross';
