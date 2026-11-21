import { describe, expect, it } from 'vitest';
import { execShell } from '../../../../electron/main/services/shell.service';

describe('sdk-contract integration: shell.service execShell', () => {
  it('T5.a captures stdout and zero exit code', async () => {
    const result = await execShell({
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("hi")'],
    });

    expect(result.stdout).toBe('hi');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('T5.b terminates a long-running process on timeout', async () => {
    const result = await execShell({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  }, 5000);

  it('T5.c truncates stdout above maxOutputBytes', async () => {
    const result = await execShell({
      cmd: process.execPath,
      args: ['-e', 'process.stdout.write("abcdefghij")'],
      maxOutputBytes: 3,
    });

    expect(result.stdout).toBe('abc');
    expect(result.truncated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('T5.d preserves non-zero exit codes', async () => {
    const result = await execShell({
      cmd: process.execPath,
      args: ['-e', 'process.exit(42)'],
    });

    expect(result.exitCode).toBe(42);
    expect(result.signal).toBeNull();
  });
});
