import { describe, it, expect } from 'vitest';
import { execShell } from '../../../electron/main/services/shell.service';

describe('execShell — 正常路径', () => {
  it('echo → stdout 含字符串,exitCode 0', async () => {
    const r = await execShell({ cmd: 'echo', args: ['hello'] });
    expect(r.stdout.trim()).toBe('hello');
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('非零 exit code 透传', async () => {
    const r = await execShell({ cmd: 'sh', args: ['-c', 'exit 42'] });
    expect(r.exitCode).toBe(42);
  });

  it('stderr 流捕获', async () => {
    const r = await execShell({
      cmd: 'sh',
      args: ['-c', 'echo oops 1>&2; exit 0'],
    });
    expect(r.stderr.trim()).toBe('oops');
    expect(r.exitCode).toBe(0);
  });

  it('cwd 选项生效', async () => {
    const r = await execShell({ cmd: 'pwd', args: [], cwd: '/tmp' });
    // /tmp on macOS resolves to /private/tmp
    expect(r.stdout.trim()).toMatch(/(\/private)?\/tmp/);
  });

  it('env 选项合并 process.env(传的覆盖)', async () => {
    const r = await execShell({
      cmd: 'sh',
      args: ['-c', 'echo $MY_VAR'],
      env: { MY_VAR: 'shell-test-value' },
    });
    expect(r.stdout.trim()).toBe('shell-test-value');
  });

  it('input 通过 stdin 喂进去', async () => {
    const r = await execShell({
      cmd: 'cat',
      args: [],
      input: 'piped\n',
    });
    expect(r.stdout).toBe('piped\n');
  });
});

describe('execShell — 超时', () => {
  it('timeoutMs 触发 SIGTERM,timedOut=true', async () => {
    const r = await execShell({
      cmd: 'sleep',
      args: ['5'],
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    // sleep 被 SIGTERM 杀,exitCode=null,signal 反映
    expect(r.signal).toMatch(/SIG/);
  }, 5000);
});

describe('execShell — 输出截断', () => {
  it('超 maxOutputBytes 标 truncated,但进程继续到结束', async () => {
    // 输出 200 个 a,maxOutputBytes=50 → truncate 到 50
    const r = await execShell({
      cmd: 'sh',
      args: ['-c', "printf 'a%.0s' {1..200}"],
      maxOutputBytes: 50,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(50);
    expect(r.exitCode).toBe(0); // 进程正常退
  });
});

describe('execShell — spawn 失败', () => {
  it('cmd 不存在 → error 事件 → exitCode=null + stderr 含 spawn 信息', async () => {
    const r = await execShell({ cmd: '/no/such/binary', args: [] });
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/spawn|ENOENT/i);
  });
});
