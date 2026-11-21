// 安全:拖放 OS 文件进终端时,特制文件名不得突破引号造成命令注入。
//   Q1 fish:单引号内 `\'` / `\\` 仍是转义,POSIX 的 `'\''` 拼接遇 `a\'…` 会提前闭合引号。
// 断言方式:按各 shell 文档的引号规则把 quote 结果「解析回」参数列表,必须恰好是原文件名一个参数;
// bash/zsh 本机存在时再用真实 shell 回读做端到端校验(fish 未安装时用规则模拟器)。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { quoteDropPaths } from '@/lib/terminal-drop-quote';

/** fish 词法(仅覆盖引号/转义/空白,按 fish 文档 "Quotes" 与 "Escaping Characters")。 */
function parseFish(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      has = true;
      for (i++; i < line.length && line[i] !== "'"; i++) {
        // 单引号内只有 \' 与 \\ 是转义,其余 \ 原样
        if (line[i] === '\\' && (line[i + 1] === "'" || line[i + 1] === '\\')) i++;
        cur += line[i];
      }
      if (i >= line.length) throw new Error('unterminated quote');
    } else if (c === '\\') {
      has = true;
      cur += line[++i] ?? '';
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

const FISH_PAYLOADS = [
  "/tmp/repo/a\\'; touch pwned #",
  "/tmp/repo/a\\\\'; touch pwned #",
  '/tmp/repo/trail\\',
  "/tmp/repo/\\'",
  "/tmp/o'reilly.md",
  "'lead",
];

function quoteOne(path: string, family: 'posix'): string {
  const r = quoteDropPaths([path], family);
  expect(r.skipped).toEqual([]);
  expect(r.quoted).toHaveLength(1);
  return r.quoted[0]!;
}

describe('terminal drop quoting: fish 反斜杠单引号注入(Q1)', () => {
  it.each(FISH_PAYLOADS)('posix 族引用结果在 fish 中解析回原文件名一个参数: %s', (path) => {
    expect(parseFish(quoteOne(path, 'posix'))).toEqual([path]);
  });

  for (const sh of ['/bin/bash', '/bin/zsh']) {
    it.skipIf(!existsSync(sh)).each(FISH_PAYLOADS)(`真实 ${sh} 回读等于原文件名: %s`, (path) => {
      const out = execFileSync(sh, ['-c', `printf '%s\\0' ${quoteOne(path, 'posix')}`], {
        encoding: 'utf8',
      });
      expect(out).toBe(`${path}\0`);
    });
  }

  it.skipIf(!existsSync('/bin/zsh'))('zsh RC_QUOTES 开启时同样回读原文件名', () => {
    for (const path of FISH_PAYLOADS) {
      const out = execFileSync(
        '/bin/zsh',
        ['-c', `setopt RC_QUOTES; printf '%s\\0' ${quoteOne(path, 'posix')}`],
        { encoding: 'utf8' },
      );
      expect(out).toBe(`${path}\0`);
    }
  });

  it('不含反斜杠的路径保持既有 POSIX 输出', () => {
    expect(quoteOne('/Users/me/a.txt', 'posix')).toBe('/Users/me/a.txt');
    expect(quoteOne("/Users/o'reilly.md", 'posix')).toBe("'/Users/o'\\''reilly.md'");
  });
});

describe('terminal drop quoting: 其余行为委托 shell-quote', () => {
  it('控制字符与 cmd 不可表示字符仍被拒绝', () => {
    expect(quoteDropPaths(['/tmp/evil\nrm', '/tmp/ok'], 'posix')).toEqual({
      quoted: ['/tmp/ok'],
      skipped: [{ path: '/tmp/evil\nrm', reason: 'control_char' }],
    });
    expect(quoteDropPaths(['C:\\%TEMP%'], 'cmd').skipped).toEqual([
      { path: 'C:\\%TEMP%', reason: 'cmd_unrepresentable' },
    ]);
  });
});
