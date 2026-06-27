import { describe, it, expect } from 'vitest';
import {
  charCount,
  computeTextStats,
  lineCount,
  wordCount,
} from '../../lib/text-stats';

describe('lineCount', () => {
  it('空串 → 0', () => {
    expect(lineCount('')).toBe(0);
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
  it('Windows CRLF 也算 1 行分隔(只看 \\n)', () => {
    expect(lineCount('a\r\nb')).toBe(2);
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

describe('perf P7 · computeTextStats 单遍与逐项函数逐字节等价', () => {
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
  ];
  it('lines/words/chars 与 lineCount/wordCount/charCount 一致', () => {
    for (const s of cases) {
      expect(computeTextStats(s)).toEqual({
        lines: lineCount(s),
        words: wordCount(s),
        chars: charCount(s),
      });
    }
  });

  it('空字符串统计复用稳定空对象', () => {
    expect(computeTextStats('')).toEqual({ lines: 0, words: 0, chars: 0 });
    expect(computeTextStats('')).toBe(computeTextStats(''));
  });

  it('与旧正则口径等价(回归基准)', () => {
    const oldLines = (s: string) =>
      s.length === 0 ? 0 : (s.match(/\n/g)?.length ?? 0) + 1;
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
