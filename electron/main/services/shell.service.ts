// Shell 一次性 exec(plugin app.shell.exec 后端)。
// 用 child_process.spawn 收 stdout/stderr 到 buffer,超时 SIGTERM,输出
// 上限 cap 避免 OOM。返回完整 ExecResult,plugin 等 process exit 后拿。

import { spawn } from 'node:child_process';
import { shell } from 'electron';
import { errorMessage } from '../../shared/error-message';
import type {
  IpcShellExecInput,
  IpcShellExecResult,
  IpcShellOpenExternalInput,
} from '../../shared/shell-channels';

const DEFAULT_TIMEOUT_MS = 30_000;
// 上界封顶:绑定子进程最长存活时间 / 单次 buffered 输出上限。孪生的流式版
// plugin-shell-stream 早已 `Math.min(opts.timeoutMs, MAX_TIMEOUT_MS)` 封顶到 30min,
// 而一次性 exec 此前只有 DEFAULT 没有 MAX —— 插件传 timeoutMs:2e9(~23 天,仍 < 2³¹
// 不触发 timer 截断)可把不退出的子进程 + stdout/stderr Buffer 钉到那个超时。补齐
// 同款上界,让两个兄弟入口的安全意图一致(防御未传播到平行入口)。
const MAX_TIMEOUT_MS = 30 * 60_000; // 30min,与 plugin-shell-stream MAX_TIMEOUT_MS 对齐
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_OUTPUT_BYTES_CAP = 100 * 1024 * 1024; // 100MB 硬上限,防超大值钉住内存
const SIGKILL_GRACE_MS = 500;

/** timeoutMs 落到 [_, MAX_TIMEOUT_MS];缺省走 DEFAULT。纯函数,便于测试 clamp。 */
export function clampExecTimeoutMs(input?: number): number {
  return Math.min(input ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

/** maxOutputBytes 落到 [_, MAX_OUTPUT_BYTES_CAP];缺省走 DEFAULT。纯函数。 */
export function clampExecMaxBytes(input?: number): number {
  return Math.min(input ?? DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES_CAP);
}

export const EXEC_LIMITS_FOR_TEST = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_CAP,
} as const;

/** 跑一个进程到 exit,buffered 输出 + 超时 + 大小上限. */
export function execShell(input: IpcShellExecInput): Promise<IpcShellExecResult> {
  return new Promise((resolve) => {
    const timeoutMs = clampExecTimeoutMs(input.timeoutMs);
    const maxBytes = clampExecMaxBytes(input.maxOutputBytes);
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
        stderr: `spawn failed: ${errorMessage(err)}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    // 按**字节**累加并封顶,最后一次性解码 —— 旧实现用 `string.length`(UTF-16
    // code unit)当字节比较,且对每个 data chunk 单独 toString,多字节 UTF-8 序列
    // 被切到两个 chunk 时边界产生替换字符(乱码)。收集 Buffer 后 concat 再 decode
    // 消除跨 chunk 乱码;按 byteLength 封顶兑现 maxOutputBytes 的字节语义(审计 P2)。
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;

    const append = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      const chunks = which === 'stdout' ? stdoutChunks : stderrChunks;
      const curBytes = which === 'stdout' ? stdoutBytes : stderrBytes;
      if (curBytes >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - curBytes;
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
      chunks.push(take);
      if (which === 'stdout') stdoutBytes += take.length;
      else stderrBytes += take.length;
      if (chunk.length > room) truncated = true;
    };

    const decode = (chunks: Buffer[]): string =>
      Buffer.concat(chunks).toString('utf-8');

    child.stdout?.on('data', (c: Buffer) => append('stdout', c));
    child.stderr?.on('data', (c: Buffer) => append('stderr', c));

    if (input.input !== undefined && child.stdin) {
      // 子进程不读 stdin / 写入前就退出时,向已关闭的管道写会在 stdin 流上发
      // 'error'(EPIPE)。stdin 是独立 emitter,'error' 无监听者会上抛为
      // uncaughtException;electron/main 没有任何 uncaughtException 兜底 →
      // 一次 EPIPE 崩溃整个主进程(所有窗口 + 未保存状态全丢)。挂 'error'
      // 监听吞掉,并 try/catch 同步 write/end(进程已退出的边界)。
      child.stdin.on('error', () => {
        /* EPIPE / 管道已关闭:子进程不读 stdin,忽略,exit/close 会照常 resolve */
      });
      try {
        child.stdin.write(input.input);
        child.stdin.end();
      } catch {
        /* 已关闭的 stdin 同步抛错:同样忽略,交给 close/error 收尾 */
      }
    }

    // exited 标记进程是否真正退出('close'/'error' 触发)。SIGKILL 升级必须以此判定,
    // 不能用 `child.killed` —— 后者在 `kill('SIGTERM')` 成功**发出信号**后即为 true
    // (Node 语义:killed = 信号已发送,非进程已退出),会让 `if (!child.killed)` 恒假、
    // SIGKILL 分支永不执行,吞掉 SIGTERM 的子进程永远不被强杀(审计 P1)。
    let exited = false;
    // 内层 SIGKILL grace timer 必须存句柄并在 close/error 清掉:否则进程在 grace 期内
    // 正常退出(常态)后,这个 timer 仍挂 SIGKILL_GRACE_MS,闭包持 child 引用阻止 GC、
    // 且让 event loop 多活一截。fire 时 `!exited` 为假只是 no-op,但资源未闭环。
    // unref 兜底:即使漏清也不阻止进程退出。见第十四轮 P2-AP。
    let killTimer: NodeJS.Timeout | null = null;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch { /* */ }
      // grace period 后还没退 → SIGKILL
      killTimer = setTimeout(() => {
        killTimer = null;
        try {
          if (!exited) child.kill('SIGKILL');
        } catch { /* */ }
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

    child.on('error', (err) => {
      exited = true;
      clearTimers();
      resolve({
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks) + `\nspawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
      });
    });

    child.on('close', (code, signal) => {
      exited = true;
      clearTimers();
      resolve({
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: code,
        signal: typeof signal === 'string' ? signal : null,
        timedOut,
        truncated,
      });
    });
  });
}

// shell.openExternal 白名单 scheme:仅 http/https/mailto/file。其他 scheme
// (如 javascript:、custom://)拒绝,防止恶意 markdown 通过 [text](javascript:...)
// 在主机执行任意代码 / 触发 protocol handler。Electron 文档同款建议。
const OPEN_EXTERNAL_SCHEME_WHITELIST = /^(https?|mailto|file):/i;

/**
 * 是否允许把该 URL 交给系统打开。所有调用 `shell.openExternal` 的入口都必须先过
 * 这个白名单 —— 包括 `windowOpenHandler` 的 deny 分支(`target="_blank"` 锚点点击,
 * 如 marketplace 的不受信 `authorUrl` / 评论 `url`)。共享同一断言,避免某个入口
 * 漏接白名单成为协议处理器投放面。
 */
export function isAllowedExternalUrl(url: string): boolean {
  return OPEN_EXTERNAL_SCHEME_WHITELIST.test(url);
}

export async function openExternalUrl(
  input: IpcShellOpenExternalInput,
): Promise<void> {
  const url = input.url;
  if (!isAllowedExternalUrl(url)) {
    throw new Error(
      `[shell.openExternal] scheme not allowed: ${url.slice(0, 32)}...`,
    );
  }
  await shell.openExternal(url);
}
