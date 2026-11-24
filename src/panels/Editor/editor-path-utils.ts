import { t as translate } from '@/i18n';
import { basename } from '@/lib/path-cross';

/**
 * 编辑 tab 的显示名:有路径取 basename,草稿(无路径)用「未命名」。tab 条与关闭 / 覆盖确认框共用 —— 此前两处各写
 * 一份,tab 上叫「未命名」、确认框里叫「草稿」,同一个 tab 两个名字。
 */
export function editorTabTitle(filePath: string | null): string {
  return filePath ? basename(filePath) : translate('panels.editor.untitled');
}

function isAsciiCharCaseInsensitive(
  path: string,
  index: number,
  lowerCode: number,
): boolean {
  const code = path.charCodeAt(index);
  return code === lowerCode || code === lowerCode - 32;
}

/**
 * 编辑 tab 是否按 Markdown 处理(决定 Milkdown / 模式切换 / unsafe 守卫):草稿(无路径)按 Markdown;有路径看扩展名。
 * 编辑面板与 editor.store 的 unsafe 判定共用 —— 此前面板判草稿是 Markdown、store 判不是,草稿的 unsafe 守卫失效。
 * 注意与「能否自动保存」无关(草稿无路径,自动保存另行判定)。
 */
export function isMarkdownTab(filePath: string | null): boolean {
  return filePath === null || filePath === '' ? true : isMarkdownPath(filePath);
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
