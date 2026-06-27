// 边界(E12,E11 同族):shell.exec 的 ExecInput 给 cmd/args/cwd/env/input 加长度/数量上限。
// stdout/stderr 已 cap,但 stdin/env/args 超大仍可让 main 持有大对象、spawn E2BIG/卡顿。超限 →
// zod 校验失败(safeHandle 走 BAD_INPUT 拒绝)。镜像 TerminalCreateInputSchema(E11)。
import { describe, it, expect } from 'vitest';
import { ExecInput } from '../../../electron/main/ipc/shell.ipc';

describe('ExecInput 长度/数量上限 (E12)', () => {
  const base = { cmd: 'echo', args: [] as string[] };

  it('正常 payload → ok', () => {
    expect(
      ExecInput.safeParse({
        cmd: 'git',
        args: ['commit', '-m', 'msg'],
        cwd: '/repo',
        env: { PATH: '/usr/bin' },
        input: 'hello',
      }).success,
    ).toBe(true);
  });

  it('cmd 空 → fail(既有 min(1))', () => {
    expect(ExecInput.safeParse({ cmd: '', args: [] }).success).toBe(false);
  });

  it('args 数量超上限 → fail', () => {
    const args = Array.from({ length: 1025 }, () => 'x');
    expect(ExecInput.safeParse({ ...base, args }).success).toBe(false);
  });

  it('单个 arg 超长 → fail', () => {
    expect(
      ExecInput.safeParse({ ...base, args: ['x'.repeat(16385)] }).success,
    ).toBe(false);
  });

  it('cmd / cwd 超长 → fail', () => {
    expect(
      ExecInput.safeParse({ cmd: 'x'.repeat(8193), args: [] }).success,
    ).toBe(false);
    expect(
      ExecInput.safeParse({ ...base, cwd: '/' + 'x'.repeat(8192) }).success,
    ).toBe(false);
  });

  it('input(stdin)超长 → fail', () => {
    expect(
      ExecInput.safeParse({ ...base, input: 'x'.repeat(1_000_001) }).success,
    ).toBe(false);
  });

  // 边界(E129,E125 同族):stdin 按真实 UTF-8 字节。CJK 3 bytes/字:334k 字 = 1.002MB 字节但
  // length 334k ≤ 1MB,旧 .max(STDIN_MAX) 按 code unit 会误放行。
  it('E129 input 多字节真实字节超 1MB(length 未超)→ fail', () => {
    expect(
      ExecInput.safeParse({ ...base, input: '中'.repeat(334_000) }).success,
    ).toBe(false);
  });

  it('E129 input 多字节但真实字节未超 → ok', () => {
    expect(
      ExecInput.safeParse({ ...base, input: '中'.repeat(100) }).success,
    ).toBe(true);
  });

  it('env 条目数 / value 超长 → fail', () => {
    const env: Record<string, string> = {};
    for (let i = 0; i < 1025; i++) env[`K${i}`] = 'v';
    expect(ExecInput.safeParse({ ...base, env }).success).toBe(false);
    expect(
      ExecInput.safeParse({ ...base, env: { FOO: 'x'.repeat(32769) } }).success,
    ).toBe(false);
  });

  // 边界(E186,E185 兄弟):env 改共享有界早停校验(makeEnvBoundedValidator)。补 key超长/非对象/
  // 非 string value/合法 env 用例(与 terminal-create E185 等价)。
  it('E186 env key 超长 → fail', () => {
    expect(
      ExecInput.safeParse({ ...base, env: { ['K'.repeat(1025)]: 'v' } }).success,
    ).toBe(false);
  });
  it('E186 env 非对象(数组/字符串)→ fail', () => {
    expect(ExecInput.safeParse({ ...base, env: ['a'] }).success).toBe(false);
    expect(ExecInput.safeParse({ ...base, env: 'x' }).success).toBe(false);
  });
  it('E186 env value 非字符串 → fail', () => {
    expect(
      ExecInput.safeParse({ ...base, env: { FOO: 1 } as never }).success,
    ).toBe(false);
  });
  it('E186 合规 env(上限内 / 空)→ ok', () => {
    expect(
      ExecInput.safeParse({ ...base, env: { PATH: '/bin', LANG: 'en_US' } })
        .success,
    ).toBe(true);
    expect(ExecInput.safeParse({ ...base, env: {} }).success).toBe(true);
  });
});
