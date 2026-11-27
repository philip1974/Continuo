// 文本统计纯函数(StatusBar 用)。
//
// 性能 P7:旧实现 lineCount 用 `match(/\n/g)`(分配全部换行的匹配数组)、wordCount 用
// `trim().split(/\s+/)`(分配全部单词的子串数组)。长文件每次输入都在 StatusBar 侧
// 全文扫描两遍 + 分配大临时数组(GC 压力)。改为 charCodeAt 单遍、零数组分配,语义
// 与正则版逐字节等价。StatusBar 走 computeTextStats 一遍同时拿三项(不重复扫)。

// 单词切分用 JS 正则 \s 的码点集合(共享 isEcmaWhitespaceCode);不含 CJK / 全角标点的文本与旧 split(/\s+/) 逐字节等价。
import { isEcmaWhitespaceCode } from '../../electron/shared/ecma-whitespace';

export interface TextStats {
  readonly lines: number;
  readonly words: number;
  readonly chars: number;
}

const EMPTY_TEXT_STATS: TextStats = { lines: 1, words: 0, chars: 0 };

const WORD = 0;
const CJK = 1;
const SEPARATOR = 2;
const NEUTRAL = 3;

/** 码点(≥ U+2010)在字数统计里的角色:普通词字符 / CJK 每字一词 / 分词符(空白、全角标点)/ 中性(通用标点)。 */
function wordCharKind(cp: number): number {
  if (cp <= 0x205e) {
    // 通用标点 U+2010–2027、U+2030–205E;其间的空白(U+2028 / 2029 / 202F / 205F)按空白
    if (isEcmaWhitespaceCode(cp)) return SEPARATOR;
    return cp <= 0x2027 || cp >= 0x2030 ? NEUTRAL : WORD;
  }
  if (cp < 0x2e80) return isEcmaWhitespaceCode(cp) ? SEPARATOR : WORD;
  if (cp <= 0x2fdf) return CJK; // 部首补充 / 康熙部首
  if (cp <= 0x303f) {
    // CJK 符号与标点:々 〆 〇、苏州码子、〸〹〺 是字;U+3000 全角空格与其余标点分词
    if ((cp >= 0x3005 && cp <= 0x3007) || (cp >= 0x3021 && cp <= 0x3029) || (cp >= 0x3038 && cp <= 0x303b)) return CJK;
    return SEPARATOR;
  }
  if (cp <= 0x30ff) {
    // 平假名 / 片假名;゠ 与中点 ・ 是标点
    return cp === 0x30a0 || cp === 0x30fb ? SEPARATOR : CJK;
  }
  if (cp >= 0x31c0 && cp <= 0x31ff) return CJK; // CJK 笔画、片假名语音扩展
  if (cp >= 0x3400 && cp <= 0x4dbf) return CJK; // 扩展 A
  if (cp >= 0x4e00 && cp <= 0x9fff) return CJK; // 基本区
  if (cp >= 0xf900 && cp <= 0xfaff) return CJK; // 兼容表意字
  if (cp >= 0xfe10 && cp <= 0xfe1f) return SEPARATOR; // 竖排标点
  if (cp >= 0xfe30 && cp <= 0xfe6f) return SEPARATOR; // CJK 兼容形式、小写变体
  if (cp >= 0xff01 && cp <= 0xff65) {
    // 全角 ASCII:数字 / 字母是词字符,其余(！，．：；？「」等)与半角片假名前的标点分词
    if ((cp >= 0xff10 && cp <= 0xff19) || (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a)) return WORD;
    return SEPARATOR;
  }
  if (cp >= 0xff66 && cp <= 0xff9f) return CJK; // 半角片假名
  if (cp >= 0x1b000 && cp <= 0x1b16f) return CJK; // 假名补充 / 扩展
  if (cp >= 0x20000 && cp <= 0x3ffff) return CJK; // 扩展 B–I、兼容补充(第 2、3 平面)
  return isEcmaWhitespaceCode(cp) ? SEPARATOR : WORD;
}

/**
 * 单遍、零数组分配地算 行/词/字符。语义:
 * - lines:换行数 + 1,与编辑器(CodeMirror doc.lines,按 /\r\n?|\n/ 切行)显示的行数一致 —— 空串 1 行、
 *   尾部换行算下一空行;\r\n 计 1 个换行,孤立 \r 也计换行。
 * - words:按空白切词(极大非空白连续段,首尾空白不计),另按 CJK 口径(同 Word / Typora / Obsidian 的中日文字数):
 *   CJK 表意字(含扩展 A–I 区、兼容表意字;扩展 B 起是代理对)与平假名 / 片假名每字计 1 词,并结束当前词
 *  (「用React写」= 用 / React / 写 3 词);全角 / CJK 标点(,。「」！等)与空白一样分词、本身不计;通用标点
 *  (“” ‘’ — …)不单独成词,夹在词里照常连着(don’t 仍是 1 词)。韩文谚文仍按空格切词(韩文本就以空格分词)。
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
    // 快路径:U+2010 以下(ASCII / 拉丁 / 西里尔等)只看空白,与旧口径逐字节相同,大文件不多付分类成本
    if (c < 0x2010) {
      if (isEcmaWhitespaceCode(c)) inWord = false;
      else if (!inWord) {
        words++;
        inWord = true;
      }
      continue;
    }
    let cp = c;
    // 代理对:扩展 B 起的表意字 / 假名补充在辅助平面,按完整码点分类,低位码元一并跳过(一字只计一次)
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = (c - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        i++;
      }
    }
    const kind = wordCharKind(cp);
    if (kind === CJK) {
      words++;
      inWord = false;
    } else if (kind === SEPARATOR) {
      inWord = false;
    } else if (kind === WORD && !inWord) {
      words++;
      inWord = true;
    }
    // NEUTRAL:不起新词,在词里照常连着
  }
  return { lines, words, chars: len - crlf };
}
