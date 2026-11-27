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

describe('wordCount · CJK 口径(中日文每字一词,同 Word / Typora / Obsidian)', () => {
  it('整段中文:每个汉字计 1 词(不再整段算 1 个)', () => {
    expect(wordCount('今天天气很好')).toBe(6);
    expect(wordCount('中文 词 测试\n第二行')).toBe(8);
  });
  it('平假名 / 片假名每字计 1 词;中点 ・ 不计', () => {
    expect(wordCount('ひらがな')).toBe(4);
    expect(wordCount('カタカナ・テスト')).toBe(7);
    expect(wordCount('ｶﾀｶﾅ')).toBe(4); // 半角片假名
  });
  it('中英混排:CJK 字结束当前英文词,英文词照常按整词计', () => {
    expect(wordCount('用React写组件')).toBe(5); // 用 / React / 写 / 组 / 件
    expect(wordCount('hello世界world')).toBe(4);
    expect(wordCount('Vue 3 很好用')).toBe(5);
  });
  it('全角 / CJK 标点不计词,且与空白一样分词', () => {
    expect(wordCount('你好，世界！')).toBe(4);
    expect(wordCount('「引用」《书名》、。')).toBe(4);
    expect(wordCount('React，Vue')).toBe(2);
    expect(wordCount('，。！？')).toBe(0);
    expect(wordCount('中文\u3000空格')).toBe(4); // 全角空格
  });
  it('通用标点(“” — …)不单独成词;夹在英文词里照常连着', () => {
    expect(wordCount('他说“你好”……')).toBe(4);
    expect(wordCount('a — b')).toBe(2);
    expect(wordCount('don’t stop')).toBe(2);
  });
  it('全角字母 / 数字是普通词字符', () => {
    expect(wordCount('ＡＢＣ　１２３')).toBe(2);
  });
  it('扩展区表意字(代理对)每字计 1 词,不按 2 个码元算两次', () => {
    expect(wordCount('𠀀𪚥')).toBe(2); // 扩展 B
    expect(wordCount('a𠀀b')).toBe(3);
    expect(wordCount('㐀')).toBe(1); // 扩展 A
    expect(charCount('𠀀')).toBe(2); // 字符数口径不变(UTF-16 code unit)
  });
  it('韩文仍按空格切词', () => {
    expect(wordCount('안녕하세요 세계')).toBe(2);
  });
  it('emoji(代理对)仍按非空白段计,不当 CJK', () => {
    expect(wordCount('🌍')).toBe(1);
    expect(wordCount('hi 🌍🌍 there')).toBe(3);
    expect(wordCount('你🌍好')).toBe(3);
  });
  it('孤立代理码元不越界、不吞后面的字', () => {
    expect(wordCount('\ud840中')).toBe(2);
    expect(wordCount('中\udc00')).toBe(2);
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
  // 与编辑器(CodeMirror doc.length)一致:CodeMirror 按 /\r\n?|\n/ 切行,每个换行(含 \r\n)在文档里只占 1 个字符
  it('Windows CRLF 计 1 个字符(crlf 文件不再多算 \r)', () => {
    expect(charCount('a\r\nb\r\nc\r\n')).toBe(6);
    expect(charCount('\r\n')).toBe(1);
  });
  it('孤立 \r 仍计 1 个字符(它本身就是一个换行)', () => {
    expect(charCount('a\rb')).toBe(3);
    expect(charCount('a\r\rb')).toBe(4);
  });
  it('与 CodeMirror 打开同一文本后的 doc.length 逐一相等(编辑器里的字符数)', () => {
    const samples = ['', 'a', 'a\n', '\n\n', 'a\r\nb\r\n', 'a\rb', 'a\r\n\rb\n', '\r', '\r\n', '\r\r\n\n', '🌍\r\n中文'];
    for (const s of samples) {
      expect(charCount(s), JSON.stringify(s)).toBe(EditorState.create({ doc: s }).doc.length);
    }
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
    'a\rb\r\n',
  ];
  it('空字符串统计复用稳定空对象', () => {
    expect(computeTextStats('')).toEqual({ lines: 1, words: 0, chars: 0 });
    expect(computeTextStats('')).toBe(computeTextStats(''));
  });

  it('不含 CJK / 全角标点的文本与正则口径等价(回归基准;行 = CodeMirror 的 /\\r\\n?|\\n/ 切分段数)', () => {
    const oldLines = (s: string) => s.split(/\r\n?|\n/).length;
    const oldWords = (s: string) =>
      s.trim() === '' ? 0 : s.trim().split(/\s+/).length;
    for (const s of cases) {
      const r = computeTextStats(s);
      expect(r.lines).toBe(oldLines(s));
      expect(r.words).toBe(oldWords(s));
      expect(r.chars).toBe(s.replace(/\r\n/g, '\n').length);
    }
  });
});

describe('大文件性能(每次输入都在状态栏全文扫描)', () => {
  // 拉丁文本走快路径(只判空白),CJK 文本多一次码点分类;两者都应在百毫秒量级内扫完数 MB
  const latin = 'lorem ipsum dolor sit amet, consectetur adipiscing elit\n'.repeat(80_000); // ≈4.6MB
  const cjk = '今天天气很好，我们去公园散步吧。Hello 世界！\n'.repeat(120_000); // ≈3.4M 码元
  it('数 MB 文本单次统计不超过 1 秒,且结果正确', () => {
    const t0 = performance.now();
    const a = computeTextStats(latin);
    const b = computeTextStats(cjk);
    const ms = performance.now() - t0;
    expect(a.words).toBe(8 * 80_000);
    expect(b.words).toBe((14 + 1 + 2) * 120_000);
    expect(ms).toBeLessThan(1000);
  });
});
