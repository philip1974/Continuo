// 搜索结果右键「复制 / 复制全部」的文本格式(VSCode searchActionsCopy matchToString / fileMatchToString /
// allFolderMatchesToString):匹配 = `行,列: 预览`;文件 = 绝对路径 + 换行 + 各匹配(缩进 2);全部 = 各文件以空行分隔。
// 换行在 Windows 上为 \r\n(VSCode lineDelimiter)。预览是结果行的预览文本(已去行首空白、过长截断),VSCode 用整行。
// BDD: src/__tests__/list-context-menus/

import { isWindowsRuntime } from '@/lib/path-cross';
import type { SearchFileResult, SearchMatch } from '../../../electron/shared/workspace-search';

export function searchLineDelimiter(): string {
  return isWindowsRuntime() ? '\r\n' : '\n';
}

export function searchMatchText(m: SearchMatch, indent = 0): string {
  return `${' '.repeat(indent)}${m.line},${m.column}: ${m.preview}`;
}

export function searchFileText(file: SearchFileResult, eol: string): string {
  return [file.path, ...file.matches.map((m) => searchMatchText(m, 2))].join(eol);
}

export function searchAllText(files: readonly SearchFileResult[], eol: string): string {
  return files
    .filter((f) => f.matches.length > 0)
    .map((f) => searchFileText(f, eol))
    .join(eol + eol);
}
