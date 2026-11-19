// 安全(Q2,Windows):拖放 OS 文件进 PowerShell 终端时,特制文件名不得突破引号造成命令注入。
// PowerShell 把 U+2018–U+201B 与 ASCII ' 一样当单引号定界符;只双写 ASCII ' 时 `a’;calc;’.txt`
// 会被 `’` 提前闭合 → 回车执行 calc。pwsh 未安装,按 PowerShell tokenizer 规则模拟解析断言。
import { describe, expect, it } from 'vitest';
import { quoteDropPaths } from '@/lib/terminal-drop-quote';

const PS_SQ = /['\u2018\u2019\u201a\u201b]/;
/** PowerShell 单引号串词法(tokenizer:任一单引号类字符都是定界符,两个连续单引号类字符 = 一个字面量)。 */
function parsePowerShell(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (PS_SQ.test(c)) {
      has = true;
      for (i++; ; i++) {
        if (i >= line.length) throw new Error('unterminated quote');
        const d = line[i]!;
        if (PS_SQ.test(d)) {
          if (!PS_SQ.test(line[i + 1] ?? '')) break;
          cur += d;
          i++;
          continue;
        }
        cur += d;
      }
    } else if (c === ' ') {
      if (has) args.push(cur);
      cur = '';
      has = false;
    } else if (c === ';' || c === '#' || c === '&' || c === '|') {
      throw new Error(`unquoted metachar ${c}`);
    } else {
      has = true;
      cur += c;
    }
  }
  if (has) args.push(cur);
  return args;
}

function quoteOne(path: string, family: 'powershell'): string {
  const r = quoteDropPaths([path], family);
  expect(r.skipped).toEqual([]);
  expect(r.quoted).toHaveLength(1);
  return r.quoted[0]!;
}

describe('terminal drop quoting: PowerShell 智能单引号注入(Q2)', () => {
  const PS_PAYLOADS = [
    'C:\\repo\\a\u2019;calc;\u2019.txt',
    'C:\\repo\\a\u2018;calc;\u2018.txt',
    'C:\\repo\\a\u201a;calc;\u201b.txt',
    "C:\\repo\\John\u2019s 'notes'.txt",
    'C:\\repo\\\u2019\u2019\u2019',
  ];

  it.each(PS_PAYLOADS)('powershell 族引用结果解析回原文件名一个参数: %s', (path) => {
    expect(parsePowerShell(quoteOne(path, 'powershell'))).toEqual([path]);
  });

  it('普通路径保持既有 PowerShell 输出', () => {
    expect(quoteOne("C:\\Users\\me\\o'reilly.txt", 'powershell')).toBe(
      "'C:\\Users\\me\\o''reilly.txt'",
    );
  });
});

describe('terminal drop quoting: PowerShell 拒绝规则不变', () => {
  it('含智能引号 + 控制字符的路径仍被拒绝', () => {
    expect(quoteDropPaths(['C:\\bad\\a\u2019\n.txt'], 'powershell').skipped).toEqual([
      { path: 'C:\\bad\\a\u2019\n.txt', reason: 'control_char' },
    ]);
  });
});
