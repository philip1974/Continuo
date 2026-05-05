// Shell 一次性 exec(plugin app.shell.exec 后端)。
// 用 child_process.spawn 收 stdout/stderr 到 buffer,超时 SIGTERM,输出
// 上限 cap 避免 OOM。返回完整 ExecResult,plugin 等 process exit 后拿。

import { spawn } from 'node:child_process';
import type {
  IpcShellExecInput,
  IpcShellExecResult,
} from '../../shared/shell-channels';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const SIGKILL_GRACE_MS = 500;

/** 跑一个进程到 exit,buffered 输出 + 超时 + 大小上限. */
export function execShell(input: IpcShellExecInput): Promise<IpcShellExecResult> {
  return new Promise((resolve) => {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const env = input.env
      ? { ...process.env, ...input.env }
      : process.env;

    let child;
    try {
      child = spawn(input.cmd, [...input.args], {
        cwd: input.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // spawn 同步抛(cmd 不可执行等)
      resolve({
        stdout: '',
        stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let truncated = false;
    let timedOut = false;

    const append = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const cur = which === 'stdout' ? stdoutBuf : stderrBuf;
      if (cur.length >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - cur.length;
      const text = chunk.toString('utf-8');
      if (text.length <= room) {
        if (which === 'stdout') stdoutBuf += text;
        else stderrBuf += text;
      } else {
        if (which === 'stdout') stdoutBuf += text.slice(0, room);
        else stderrBuf += text.slice(0, room);
        truncated = true;
      }
    };

    child.stdout?.on('data', (c: Buffer) => append('stdout', c));
    child.stderr?.on('data', (c: Buffer) => append('stderr', c));

    if (input.input !== undefined && child.stdin) {
      child.stdin.write(input.input);
      child.stdin.end();
    }

    let killed = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch { /* */ }
      // grace period 后还没退 → SIGKILL
      setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch { /* */ }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf + `\nspawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode: code,
        signal: typeof signal === 'string' ? signal : null,
        timedOut,
        truncated,
      });
      void killed; // 静态分析:killed 仅用于触发副作用,不读
    });
  });
}
