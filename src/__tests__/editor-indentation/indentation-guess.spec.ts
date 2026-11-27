// 按内容推断缩进(VSCode guessIndentation 移植)+ 设置 / 语言默认。行为见同目录 README。
import { beforeEach, describe, expect, it } from 'vitest';
import { GUESS_INDENTATION_MAX_LINES, guessIndentation } from '../../panels/Editor/indentation-guesser';
import {
  creationIndentOptions,
  languageInsertSpacesDefault,
  resolveIndentation,
} from '../../panels/Editor/editor-indentation';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';

const lines = (...l: string[]) => l.join('\n');

describe('guessIndentation(VSCode 算法)', () => {
  it('4 空格 Python → 空格 / 4', () => {
    const py = lines('def f():', '    if x:', '        return 1', '    return 2', '');
    expect(guessIndentation(py, 4, true)).toEqual({ insertSpaces: true, tabSize: 4 });
    // 默认值是 2 也推断出 4
    expect(guessIndentation(py, 2, true)).toEqual({ insertSpaces: true, tabSize: 4 });
  });

  it('tab 缩进 → tab,宽度取默认值', () => {
    const py = lines('def f():', '\tif x:', '\t\treturn 1', '\treturn 2');
    expect(guessIndentation(py, 4, true)).toEqual({ insertSpaces: false, tabSize: 4 });
    expect(guessIndentation(py, 8, true)).toEqual({ insertSpaces: false, tabSize: 8 });
  });

  it('2 空格 → 2;2 的次数 ≥ 4 的 2/3 时 2 胜出', () => {
    expect(guessIndentation(lines('a:', '  b:', '    c: 1', '  d: 2'), 4, true)).toEqual({ insertSpaces: true, tabSize: 2 });
    // 相邻行缩进差 4 出现 3 次、2 出现 2 次(2 ≥ 3×2/3)→ 2
    const mixed = lines('a', '    b', 'c', '    d', '      e', '        f');
    expect(guessIndentation(mixed, 8, true).tabSize).toBe(2);
    // 4 出现 4 次、2 出现 2 次(2 < 4×2/3)→ 4
    expect(guessIndentation(lines('a', '    b', 'c', '    d', 'e', '  f', '    g'), 8, true).tabSize).toBe(4);
  });

  it('空文件 / 无缩进 / tab 与空格行数相等 → 默认值', () => {
    expect(guessIndentation('', 4, true)).toEqual({ insertSpaces: true, tabSize: 4 });
    expect(guessIndentation('a\nb\nc', 3, false)).toEqual({ insertSpaces: false, tabSize: 3 });
    expect(guessIndentation(lines('a', '\tb', 'c', '    d'), 4, false).insertSpaces).toBe(false);
    expect(guessIndentation(lines('a', '\tb', 'c', '    d'), 4, true).insertSpaces).toBe(true);
  });

  it('CRLF 行尾不影响推断;空白行不计', () => {
    const crlf = 'def f():\r\n    a = 1\r\n\r\n    \r\n    if a:\r\n        pass\r\n';
    expect(guessIndentation(crlf, 2, true)).toEqual({ insertSpaces: true, tabSize: 4 });
  });

  it('逗号结尾后的对齐续行不当作缩进', () => {
    const js = lines('const a = 1,', '      b = 2;', 'function f() {', '  return 1;', '}');
    expect(guessIndentation(js, 4, true)).toEqual({ insertSpaces: true, tabSize: 2 });
  });

  it('只看前 10000 行(大文件推断不随文件变长)', () => {
    const head = Array.from({ length: GUESS_INDENTATION_MAX_LINES / 2 }, () => 'a\n    b').join('\n');
    const tail = Array.from({ length: 20_000 }, () => 'x\n\ty').join('\n');
    expect(guessIndentation(`${head}\n${tail}`, 4, true)).toEqual({ insertSpaces: true, tabSize: 4 });
    expect(guessIndentation(`${tail}\n${head}`, 4, true).insertSpaces).toBe(false);
  });
});

describe('设置与语言默认', () => {
  beforeEach(() => useSettingsValuesStore.setState({ values: {} }));

  it('默认:tabSize 4 / insertSpaces 开 / detectIndentation 开', () => {
    expect(creationIndentOptions('/w/a.ts')).toEqual({ tabSize: 4, insertSpaces: true, detectIndentation: true });
    expect(resolveIndentation('/w/a.ts', '')).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it('Makefile / Go 默认用 tab(高于全局 insertSpaces)', () => {
    for (const p of ['/w/Makefile', '/w/makefile', '/w/GNUmakefile', '/w/x.mk', '/w/x.mak', '/w/main.go']) {
      expect(languageInsertSpacesDefault(p), p).toBe(false);
      expect(resolveIndentation(p, ''), p).toEqual({ tabSize: 4, insertSpaces: false });
    }
    expect(languageInsertSpacesDefault('/w/a.py')).toBeUndefined();
    // 内容是空格缩进 → 按内容(检测开着)
    expect(resolveIndentation('/w/Makefile', 'a:\n    b\n')).toEqual({ tabSize: 4, insertSpaces: true });
  });

  it('关闭检测 → 直接用设置;tabSize 越界收进 1..100', () => {
    useSettingsValuesStore.setState({
      values: { 'editor.detectIndentation': false, 'editor.tabSize': 3, 'editor.insertSpaces': false },
    });
    expect(resolveIndentation('/w/a.py', 'a:\n    b\n')).toEqual({ tabSize: 3, insertSpaces: false });
    useSettingsValuesStore.setState({ values: { 'editor.detectIndentation': false, 'editor.tabSize': 500 } });
    expect(resolveIndentation('/w/a.py', '')).toEqual({ tabSize: 100, insertSpaces: true });
  });
});
