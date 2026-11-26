// 文本统计纯函数(StatusBar 用)。
//
// 性能 P7:旧实现 lineCount 用 `match(/\n/g)`(分配全部换行的匹配数组)、wordCount 用
// `trim().split(/\s+/)`(分配全部单词的子串数组)。长文件每次输入都在 StatusBar 侧
// 全文扫描两遍 + 分配大临时数组(GC 压力)。改为 charCodeAt 单遍、零数组分配,语义
// 与正则版逐字节等价。StatusBar 走 computeTextStats 一遍同时拿三项(不重复扫)。

// 单词切分用 JS 正则 \s 的码点集合(共享 isEcmaWhitespaceCode),与旧 split(/\s+/) 逐字节等价。
import { isEcmaWhitespaceCode } from '../../electron/shared/ecma-whitespace';

export interface TextStats {
  readonly lines: number;
  readonly words: number;
  readonly chars: number;
}

const EMPTY_TEXT_STATS: TextStats = { lines: 1, words: 0, chars: 0 };

/**
 * 单遍、零数组分配地算 行/词/字符。语义:
 * - lines:换行数 + 1,与编辑器(CodeMirror doc.lines,按 /\r\n?|\n/ 切行)显示的行数一致 —— 空串 1 行、
 *   尾部换行算下一空行;\r\n 计 1 个换行,孤立 \r 也计换行。
 * - words:trim 后按 \s+ 切的段数 = 极大非空白连续段数(首尾空白不计)。
 * - chars:与编辑器(CodeMirror doc.length)一致 —— 每个换行在文档里只占 1 个字符:\r\n 计 1(不把 \r 多算),
 *   孤立 \r / \n 各计 1;其余按 UTF-16 code unit(s.length 口径)。
 */
export function computeTextStats(s: string): TextStats {
  const len = s.length;
  if (len === 0) return EMPTY_TEXT_STATS;
  let lines = 1; // 至少 1 行;尾部换行算下一行起点(空行)
  let crlf = 0; // \r\n 对数:每对在编辑器里只占 1 个字符
  let words = 0;
  let inWord = false;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    // \n;或不跟 \n 的 \r(\r\n 由其中的 \n 计)
    if (c === 0x0a) lines++;
    else if (c === 0x0d) {
      if (s.charCodeAt(i + 1) === 0x0a) crlf++;
      else lines++;
    }
    if (isEcmaWhitespaceCode(c)) {
      inWord = false;
    } else if (!inWord) {
      words++;
      inWord = true;
    }
  }
  return { lines, words, chars: len - crlf };
}
