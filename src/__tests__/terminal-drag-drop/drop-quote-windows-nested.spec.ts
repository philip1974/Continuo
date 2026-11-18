// 安全(Q3,Windows 嵌套 shell):族按 PTY 启动 shell 判定,用户在 PowerShell 终端里进了 cmd(或反之)时
// 识别不到。拖放结果必须在 cmd 与 PowerShell **两者**下都不执行任何命令,且在启动 shell 中解析回原路径。
//   - PowerShell 终端里进 cmd:`'…x&calc&.txt'` —— cmd 不认单引号,& 即命令分隔 → 回车执行 calc。
//   - cmd 终端里进 powershell:`"…$(calc).txt"` 被求值;U+201C–U+201E 智能双引号可提前闭合字符串。
// cmd/pwsh 未安装,按两者引号规则模拟解析断言(cmd:/? 与 SS64 "Escape";PowerShell:about_Quoting_Rules)。
import { describe, expect, it } from 'vitest';
import { quoteDropPaths } from '@/lib/terminal-drop-quote';

class Unsafe extends Error {}

/**
 * cmd 交互命令行:" 切换引号态;引号外 & | < > ^ 为元字符。% 任意位置先于解析展开(引号内也展开):成对的
 * `%名字%` 可能取到攻击者可控的值(动态变量 %CD% / %__CD__% / %=C:% 即当前目录名,目录可来自不可信仓库,
 * 如 `x&calc&y`),展开出的 & 随后被当作元字符 → 视为不安全。单个 %(a%20b.pdf、100%.png)不展开。
 */
function parseCmd(line: string): string[] {
  if (/%[^%]+%/.test(line)) throw new Unsafe('cmd variable expansion');
  const args: string[] = [];
  let cur = '';
  let has = false;
  let inQ = false;
  for (const c of line) {
    if (c === '"') {
      inQ = !inQ;
      has = true;
      continue;
    }
    if (!inQ && /[&|<>^]/.test(c)) throw new Unsafe(`cmd metachar ${c}`);
    if (!inQ && c === ' ') {
      if (has) args.push(cur);
      cur = '';
      has = false;
      continue;
    }
    has = true;
    cur += c;
  }
  if (inQ) throw new Unsafe('cmd unterminated quote');
  if (has) args.push(cur);
  return args;
}

const PS_SQ = /['\u2018-\u201b]/;
const PS_DQ = /["\u201c-\u201e]/;
/** PowerShell 命令模式:单引号类串纯字面(两个连续 = 一个);双引号类串内 $ 与 ` 会求值/转义;裸元字符即注入。 */
function parsePowerShell(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (PS_SQ.test(c) || PS_DQ.test(c)) {
      const delim = PS_SQ.test(c) ? PS_SQ : PS_DQ;
      has = true;
      for (i++; ; i++) {
        if (i >= line.length) throw new Unsafe('ps unterminated quote');
        const d = line[i]!;
        if (delim === PS_DQ && (d === '$' || d === '`')) throw new Unsafe(`ps expansion ${d}`);
        if (delim.test(d)) {
          if (!delim.test(line[i + 1] ?? '')) break;
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
    } else if (/[;#&|$`(){}@,<>]/.test(c)) {
      throw new Unsafe(`ps metachar ${c}`);
    } else {
      has = true;
      cur += c;
    }
  }
  if (has) args.push(cur);
  return args;
}

type WinFamily = 'cmd' | 'powershell';
const parse = (family: WinFamily, line: string) =>
  family === 'cmd' ? parseCmd(line) : parsePowerShell(line);
const other = (family: WinFamily): WinFamily => (family === 'cmd' ? 'powershell' : 'cmd');

const PAYLOADS = [
  'C:\\repo\\x&calc&.txt',
  'C:\\repo\\x|calc|.txt',
  'C:\\repo\\a^&calc.txt',
  'C:\\repo\\a$(calc).txt',
  'C:\\repo\\a`$(calc).txt',
  'C:\\repo\\a\u201c;calc;\u201c.txt',
  'C:\\repo\\a\u201d;calc;\u201e.txt',
  'C:\\repo\\a\u2019;calc;\u2019.txt',
  'C:\\repo\\a\u2019&calc&\u2019.txt',
  'C:\\repo\\a&$(calc).txt',
  'C:\\repo\\%PATH%&calc.txt',
  'C:\\repo\\a!x!&calc.txt',
  // 不可信仓库目录 `x&calc&y` 里的文件 `%CD%.txt`:PowerShell 终端里进 cmd 后拖入,%CD% 展开出 & → 执行 calc。
  'C:\\x&calc&y\\%CD%.txt',
  'C:\\repo\\a%__CD__%b.txt',
  'C:\\repo\\%=C:%.txt',
];

describe('terminal drop quoting: Windows 嵌套 shell 注入(Q3)', () => {
  for (const family of ['powershell', 'cmd'] as const) {
    it.each(PAYLOADS)(`${family} 族:要么拒绝,要么在 cmd 与 PowerShell 下都不执行命令且启动 shell 解析回原路径: %s`, (path) => {
      const r = quoteDropPaths([path], family);
      if (r.skipped.length === 1) return;
      const q = r.quoted[0]!;
      expect(parse(family, q)).toEqual([path]);
      expect(() => parse(other(family), q)).not.toThrow();
    });
  }

  it('PowerShell 终端里进 cmd:含 & 的文件名改用双引号(cmd 双引号内 & 是字面量)', () => {
    expect(quoteDropPaths(['C:\\repo\\x&calc&.txt'], 'powershell').quoted).toEqual([
      '"C:\\repo\\x&calc&.txt"',
    ]);
  });

  it('cmd 终端里进 powershell:含 $ / ` / 智能双引号的文件名拒绝', () => {
    for (const p of ['C:\\a$(calc).txt', 'C:\\a`n.txt', 'C:\\a\u201c;calc;\u201c.txt']) {
      expect(quoteDropPaths([p], 'cmd').skipped).toEqual([{ path: p, reason: 'cmd_unrepresentable' }]);
    }
  });
});

describe('terminal drop quoting: 常见 Windows 文件名不被拒绝', () => {
  const COMMON = [
    'C:\\Users\\me\\My Docs\\report (1).txt',
    "C:\\Users\\me\\o'reilly.txt",
    'C:\\Users\\me\\R&D\\a & b.txt',
    'C:\\Users\\me\\文档\\笔记 2026.md',
    "C:\\Users\\me\\Tom & Jerry's (final).docx",
  ];
  for (const family of ['powershell', 'cmd'] as const) {
    it.each(COMMON)(`${family}: %s`, (path) => {
      const r = quoteDropPaths([path], family);
      expect(r.skipped).toEqual([]);
      expect(parse(family, r.quoted[0]!)).toEqual([path]);
    });
  }

  it('PowerShell 族:含单个 % 的常见下载名(a%20b.pdf)仍用单引号形态,不被跳过', () => {
    for (const p of ['C:\\dl\\a%20b.pdf', 'C:\\dl\\100%.png', 'C:\\dl\\50%%.txt']) {
      expect(quoteDropPaths([p], 'powershell').quoted).toEqual([`'${p}'`]);
    }
  });

  it('PowerShell 族:含成对 %名字% 的路径拒绝(嵌套 cmd 中 %CD% 等可展开为不可信目录名)', () => {
    for (const p of ['C:\\dl\\%TEMP%.txt', 'C:\\repo\\%CD%.txt', 'C:\\dl\\a%20b%20c.pdf']) {
      expect(quoteDropPaths([p], 'powershell').skipped).toEqual([{ path: p, reason: 'cmd_unrepresentable' }]);
    }
  });

  it('cmd 族:含 % 的路径仍拒绝(cmd 中值会被展开改变)', () => {
    expect(quoteDropPaths(['C:\\dl\\a%20b.pdf'], 'cmd').skipped).toEqual([
      { path: 'C:\\dl\\a%20b.pdf', reason: 'cmd_unrepresentable' },
    ]);
  });

  it('PowerShell 族:不含 cmd 元字符的路径保持既有单引号输出($ 与智能引号可保留)', () => {
    expect(quoteDropPaths(["C:\\Users\\me\\o'reilly $HOME.txt"], 'powershell').quoted).toEqual([
      "'C:\\Users\\me\\o''reilly $HOME.txt'",
    ]);
    expect(quoteDropPaths(['C:\\Users\\me\\\u201creport\u201d.docx'], 'powershell').quoted).toEqual([
      "'C:\\Users\\me\\\u201creport\u201d.docx'",
    ]);
  });
});
