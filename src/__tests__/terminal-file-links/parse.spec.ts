// BDD: terminal-file-links / 1 从终端行文本识别文件路径与行列后缀
import { describe, expect, it } from 'vitest';
import {
  MAX_LINK_LINE_LENGTH,
  MAX_LINKS_PER_LINE,
  parseTerminalFileLinks,
} from '@/panels/Terminal/terminal-file-links';

const pick = (text: string) =>
  parseTerminalFileLinks(text).map((l) => ({ path: l.path, line: l.line, column: l.column, text: text.slice(l.start, l.end) }));

describe('路径 + 行列后缀', () => {
  it('src/a.ts:2:5、long.ts:300、./file-2.ts(1,3)', () => {
    expect(pick('src/a.ts:2:5')).toEqual([{ path: 'src/a.ts', line: 2, column: 5, text: 'src/a.ts:2:5' }]);
    expect(pick('long.ts:300')).toEqual([{ path: 'long.ts', line: 300, column: undefined, text: 'long.ts:300' }]);
    expect(pick('./file-2.ts(1,3)')).toEqual([{ path: './file-2.ts', line: 1, column: 3, text: './file-2.ts(1,3)' }]);
  });
  it('(line, col) / (line) / 无后缀;绝对、~、../、Windows 盘符路径', () => {
    expect(pick('at x.ts(10, 4)')[0]).toMatchObject({ path: 'x.ts', line: 10, column: 4 });
    expect(pick('x.ts(7)')[0]).toMatchObject({ path: 'x.ts', line: 7, column: undefined });
    expect(pick('/abs/dir/f.py')[0]).toMatchObject({ path: '/abs/dir/f.py', line: undefined });
    expect(pick('~/notes.md:3')[0]).toMatchObject({ path: '~/notes.md', line: 3 });
    expect(pick('../up/Makefile')[0]).toMatchObject({ path: '../up/Makefile' });
    expect(pick('C:\\w\\a.ts:4:2')[0]).toMatchObject({ path: 'C:\\w\\a.ts', line: 4, column: 2 });
  });
  it('一行多个;编译器 / 堆栈常见形态(引号、括号包裹)', () => {
    expect(pick('error in src/a.ts:1:2 and lib/b.js:3').map((l) => l.text)).toEqual(['src/a.ts:1:2', 'lib/b.js:3']);
    expect(pick('    at fn (/w/src/x.ts:12:7)').map((l) => l.text)).toEqual(['/w/src/x.ts:12:7']);
    expect(pick('File "/w/y.py", line 3').map((l) => l.path)).toEqual(['/w/y.py']);
  });
});

describe('排除误报', () => {
  it('纯数字 / 版本号 / 无扩展名无分隔符的词不是候选', () => {
    expect(pick('1999 3.14 v1.2 hello world')).toEqual([]);
  });
  it('URL 的片段不当路径(交给 WebLinksAddon);foo:bar 的 bar 不算', () => {
    expect(pick('see https://example.com/a/b.ts')).toEqual([]);
    expect(pick('key:value.ts')).toEqual([]);
  });
  it('句末的点不属于路径;行号 0 视为无行号', () => {
    expect(pick('see src/a.ts.')[0]).toMatchObject({ path: 'src/a.ts', text: 'src/a.ts' });
    expect(pick('a.ts:0')[0]).toMatchObject({ path: 'a.ts', line: undefined });
  });
  it('每行最多 MAX_LINKS_PER_LINE 个;超长行不扫描', () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join(' ');
    expect(parseTerminalFileLinks(many)).toHaveLength(MAX_LINKS_PER_LINE);
    expect(parseTerminalFileLinks(`src/a.ts ${'x'.repeat(MAX_LINK_LINE_LENGTH)}`)).toEqual([]);
  });
});
