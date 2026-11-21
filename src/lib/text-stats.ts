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

const EMPTY_TEXT_STATS: TextStats = { lines: 0, words: 0, chars: 0 };

/**
 * 单遍、零数组分配地算 行/词/字符。语义:
 * - lines:空串 0;否则 换行数 + 1(尾部 \n 算下一空行,只看 \n,CRLF 仅计 \n)。
 * - words:trim 后按 \s+ 切的段数 = 极大非空白连续段数(首尾空白不计)。
 * - chars:s.length。
 */
export function computeTextStats(s: string): TextStats {
  const len = s.length;
  if (len === 0) return EMPTY_TEXT_STATS;
  let lines = 1; // 非空至少 1 行;尾部 \n 算下一行起点(空行)
  let words = 0;
  let inWord = false;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) lines++; // \n
    if (isEcmaWhitespaceCode(c)) {
      inWord = false;
    } else if (!inWord) {
      words++;
      inWord = true;
    }
  }
  return { lines, words, chars: len };
}

// 单项版本(仅测试 / 外部按名使用):委托 computeTextStats,不再各抄一份循环。
export function lineCount(s: string): number {
  return computeTextStats(s).lines;
}

export function wordCount(s: string): number {
  return computeTextStats(s).words;
}

export function charCount(s: string): number {
  return s.length;
}
