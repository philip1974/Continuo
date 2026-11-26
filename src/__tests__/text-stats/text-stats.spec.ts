import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { computeTextStats } from '../../lib/text-stats';

const lineCount = (s: string): number => computeTextStats(s).lines;
const wordCount = (s: string): number => computeTextStats(s).words;
const charCount = (s: string): number => computeTextStats(s).chars;

describe('lineCount', () => {
  // 与编辑器(CodeMirror doc.lines)一致:空文件编辑器显示第 1 行,状态栏也是「1 行」(VSCode 同)
  it('空串 → 1(空文件也有一行)', () => {
    expect(lineCount('')).toBe(1);
  });
  it('单行无换行 → 1', () => {
    expect(lineCount('hello')).toBe(1);
  });
  it('两行 → 2', () => {
    expect(lineCount('a\nb')).toBe(2);
  });
  it('尾部 \\n → 算下一空行', () => {
    expect(lineCount('a\n')).toBe(2);
  });
  it('Windows CRLF 算 1 个换行', () => {
    expect(lineCount('a\r\nb')).toBe(2);
  });
  it('孤立 \\r(老 Mac 换行)也算换行(CodeMirror 按 /\\r\\n?|\\n/ 切行)', () => {
    expect(lineCount('a\rb')).toBe(2);
    expect(lineCount('a\r')).toBe(2);
    expect(lineCount('a\r\rb')).toBe(3);
  });
  it('与 CodeMirror 打开同一文本后的 doc.lines 逐一相等(编辑器显示的行号)', () => {
    const samples = ['', 'a', 'a\n', '\n', '\n\n', 'a\nb', 'a\nb\n', 'a\r\nb\r\n', 'a\rb', 'a\r\n\rb\n', '\r', '\r\n', '中文\n第二行'];
    for (const s of samples) {
      expect(lineCount(s), JSON.stringify(s)).toBe(EditorState.create({ doc: s }).doc.lines);
    }
  });
});

describe('wordCount', () => {
  it('空串 → 0', () => {
    expect(wordCount('')).toBe(0);
  });
  it('全空白 → 0', () => {
    expect(wordCount('   \n\t')).toBe(0);
  });
  it('单词 → 词数', () => {
    expect(wordCount('hello world')).toBe(2);
    expect(wordCount('a b c d e')).toBe(5);
  });
  it('多空格 / 制表符 / 换行混合 → 按 \\s+ 切', () => {
    expect(wordCount('a  b\tc\nd')).toBe(4);
  });
  it('首尾空白不算', () => {
    expect(wordCount('  hello  ')).toBe(1);
  });
});

describe('charCount', () => {
  it('空 → 0', () => {
    expect(charCount('')).toBe(0);
  });
  it('返字符串长度', () => {
    expect(charCount('hello')).toBe(5);
    expect(charCount('a\nb')).toBe(3);
  });
});

describe('perf P7 · computeTextStats 单遍统计', () => {
  const cases = [
    '',
    '   \n\t',
    'hello',
    'hello world',
    'a b c d e',
    'a  b\tc\nd',
    '  hello  ',
    'a\n',
    'a\r\nb',
    'line0\nline1\nline2\n',
    '中文 词 测试\n第二行',
    'a\rb\r\n',
  ];
  it('空字符串统计复用稳定空对象', () => {
    expect(computeTextStats('')).toEqual({ lines: 1, words: 0, chars: 0 });
    expect(computeTextStats('')).toBe(computeTextStats(''));
  });

  it('与正则口径等价(回归基准;行 = CodeMirror 的 /\\r\\n?|\\n/ 切分段数)', () => {
    const oldLines = (s: string) => s.split(/\r\n?|\n/).length;
    const oldWords = (s: string) =>
      s.trim() === '' ? 0 : s.trim().split(/\s+/).length;
    for (const s of cases) {
      const r = computeTextStats(s);
      expect(r.lines).toBe(oldLines(s));
      expect(r.words).toBe(oldWords(s));
      expect(r.chars).toBe(s.length);
    }
  });
});
