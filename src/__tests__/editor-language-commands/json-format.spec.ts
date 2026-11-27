// BDD: editor-language-commands 第 1 条 —— JSON 格式化只重排空白(字面量 / 注释保留)、按缩进单位、文末换行、语法错误。见同目录 README。
import { describe, expect, it } from 'vitest';
import { formatJson } from '@/panels/Editor/json-format';

describe('formatJson', () => {
  it('对象 / 数组换行缩进,`:` 后一个空格,空对象 / 空数组紧凑', () => {
    expect(formatJson('{"a":1,"b":[1,2,{}],"c":{"d":[]}}', '  ')).toBe(
      '{\n  "a": 1,\n  "b": [\n    1,\n    2,\n    {}\n  ],\n  "c": {\n    "d": []\n  }\n}',
    );
  });

  it('缩进单位跟随调用方(4 空格 / tab)', () => {
    expect(formatJson('{"a":[1]}', '    ')).toBe('{\n    "a": [\n        1\n    ]\n}');
    expect(formatJson('{"a":[1]}', '\t')).toBe('{\n\t"a": [\n\t\t1\n\t]\n}');
  });

  it('数字 / 字符串逐字符保留(不经 JSON.stringify),重复键保留', () => {
    const src = '{"n":1.0,"e":1E5,"big":12345678901234567890,"s":"\\u00e9 \\"q\\" , : { }","n":null}';
    expect(formatJson(src, '  ')).toBe(
      '{\n  "n": 1.0,\n  "e": 1E5,\n  "big": 12345678901234567890,\n  "s": "\\u00e9 \\"q\\" , : { }",\n  "n": null\n}',
    );
  });

  it('文末换行:有则保留一个,无则不加', () => {
    expect(formatJson('{"a":1}\n\n', '  ')).toBe('{\n  "a": 1\n}\n');
    expect(formatJson('{"a":1}', '  ')).toBe('{\n  "a": 1\n}');
    expect(formatJson('[1]\r\n', '  ')).toBe('[\n  1\n]\n');
  });

  it('已格式化 → 原样', () => {
    const ok = '{\n  "a": [\n    1\n  ]\n}\n';
    expect(formatJson(ok, '  ')).toBe(ok);
  });

  it('jsonc 注释保留:行尾注释仍在同一行,独占一行的注释独占一行', () => {
    const src = '{\n// head\n"a": 1, // tail\n/* block */ "b": [2]\n}\n';
    expect(formatJson(src, '  ')).toBe('{\n  // head\n  "a": 1, // tail\n  /* block */ "b": [\n    2\n  ]\n}\n');
  });

  it('标量顶层值', () => {
    expect(formatJson('  "x"  ', '  ')).toBe('"x"');
    expect(formatJson('42\n', '  ')).toBe('42\n');
  });

  it('语法错误 → null(缺逗号 / 尾逗号 / 未闭合 / 单引号)', () => {
    for (const bad of ['{"a":1 "b":2}', '{"a":1,}', '{"a":[1', '{"a":"x}', "{'a':1}", '{"a":01x}']) {
      expect(formatJson(bad, '  '), bad).toBeNull();
    }
  });

  it('空白 / 只有注释 → 原样(无可格式化内容)', () => {
    expect(formatJson('  \n', '  ')).toBe('  \n');
    expect(formatJson('// x\n', '  ')).toBe('// x\n');
  });

  it('BOM 保留', () => {
    expect(formatJson('﻿{"a":1}', '  ')).toBe('﻿{\n  "a": 1\n}');
  });
});
