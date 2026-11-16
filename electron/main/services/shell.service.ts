// Shell 一次性 exec(plugin app.shell.exec 后端)。
// 用 child_process.spawn 收 stdout/stderr 到 buffer,超时 SIGTERM,输出
// 上限 cap 避免 OOM。返回完整 ExecResult,plugin 等 process exit 后拿。

import { startsWithAllowedExternalScheme } from '../../shared/url-limits';
import { spawn } from 'node:child_process';
import { shell } from 'electron';
import { codedError, errorMessage } from '../../shared/error-message';
import { ERROR_CODES } from '../../shared/error-codes';
import { SHELL_MAX_TIMEOUT_MS } from '../../shared/shell-limits';
import type { ChildProcess } from 'node:child_process';
import {
  killProcessTreesNow,
  processTreeKillable,
  TREE_KILL_DETACHED,
} from '../lib/kill-with-grace';
import { trackPluginShellProcess } from '../lib/plugin-shell-owners';
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
const MAX_TIMEOUT_MS = SHELL_MAX_TIMEOUT_MS; // 30min,与 plugin-shell-stream 同一来源
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_OUTPUT_BYTES_CAP = 100 * 1024 * 1024; // 100MB 硬上限,防超大值钉住内存
const SIGKILL_GRACE_MS = 500;
// 超时终止进程树后仍等不到 close 时,最多再等这么久即强制结算。
const FORCE_SETTLE_MS = 3000;

// 边界(E248,E10/E122 clamp 非有限值族):helper 自身完整归一化,不依赖 IPC zod 前门。execShell 与这两个
// helper 都是导出 service 入口(单测/SDK 集成/未来内部调用直接用,绕过 schema)。旧实现仅 Math.min(input,
// MAX) —— input=NaN → Math.min(NaN,MAX)=NaN(setTimeout 立即触发 / 截断逻辑不可预期),input≤0/负 →
// 原样返回(负 timeout 立即超时)。非有限/≤0 回默认值,有限正数再 Math.trunc(整数 ms/字节)+ 上限裁剪。
/** timeoutMs 归一到 (0, MAX_TIMEOUT_MS];非有限/≤0/缺省走 DEFAULT。纯函数,便于测试 clamp。 */
export function clampExecTimeoutMs(input?: number): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.trunc(input), MAX_TIMEOUT_MS);
}

/** maxOutputBytes 归一到 (0, MAX_OUTPUT_BYTES_CAP];非有限/≤0/缺省走 DEFAULT。纯函数。 */
export function clampExecMaxBytes(input?: number): number {
  if (input === undefined || !Number.isFinite(input) || input <= 0) {
    return DEFAULT_MAX_OUTPUT_BYTES;
  }
  return Math.min(Math.trunc(input), MAX_OUTPUT_BYTES_CAP);
}

export const EXEC_LIMITS_FOR_TEST = {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES_CAP,
} as const;

// 在途(尚未 close)的 exec 子进程,供退出清理。子进程是 detached 进程组,不随 IDE 退出而终止。
const inFlight = new Set<ChildProcess>();

// 终审 P1(E230 同族,数量上限):在途 exec 子进程并发上限。插件循环调用 exec 不 await → 此前无限 spawn,耗尽
// PID / FD。与 plugin-shell-stream 同款全局 + 单 sender 双闸,spawn 前 fail-fast 拒绝(不 spawn、不起 timer)。
const MAX_ACTIVE_EXECS_GLOBAL = 128;
const MAX_ACTIVE_EXECS_PER_SENDER = 32;
/** senderId → 在途 exec 数(无 senderId 的内部调用只计全局)。 */
const inFlightBySender = new Map<number, number>();

export const MAX_ACTIVE_EXECS_GLOBAL_FOR_TEST = MAX_ACTIVE_EXECS_GLOBAL;
export const MAX_ACTIVE_EXECS_PER_SENDER_FOR_TEST = MAX_ACTIVE_EXECS_PER_SENDER;

/** 退出清理(before-quit awaited):立即强杀所有在途 exec 的进程树并等待 close(有上限)。 */
export function cleanupAllShellExecs(): Promise<void> {
  return killProcessTreesNow(inFlight);
}

/**
 * 跑一个进程到 exit,buffered 输出 + 超时 + 大小上限.
 * @param senderId 发起请求的 webContents id(IPC 入口传入):与 input.pluginId 一起登记进程归属,
 *   插件停用/卸载时按 (窗口, 插件) 终止(终审 P1)。
 */
export function execShell(
  input: IpcShellExecInput,
  senderId?: number,
): Promise<IpcShellExecResult> {
  if (
    inFlight.size >= MAX_ACTIVE_EXECS_GLOBAL ||
    (senderId !== undefined &&
      (inFlightBySender.get(senderId) ?? 0) >= MAX_ACTIVE_EXECS_PER_SENDER)
  ) {
    return Promise.reject(
      codedError(ERROR_CODES.TOO_MANY_STREAMS, 'too many active shell execs'),
    );
  }
  return new Promise((resolve) => {
    const timeoutMs = clampExecTimeoutMs(input.timeoutMs);
    const maxBytes = clampExecMaxBytes(input.maxOutputBytes);
    const env = input.env
      ? { ...process.env, ...input.env }
      : process.env;

    let child;
    try {
      // 注:不用 `shell: true`。spawn 的契约是参数数组原子传递;Windows 上 shell:true
      // 会把 args[] 重新拼进 cmd.exe 命令行,含空格/`&`/`|`/`%` 的参数被拆分或当 shell
      // 语法执行 → 破坏参数原子性 + 命令注入面(codex diff 复查)。Windows 下 `.cmd`/
      // `.bat`(npm/pnpm 等)无法直接 spawn 的正确解法是 PATHEXT 检测 + 仅对 .cmd/.bat
      // 走 `cmd.exe /d /s /c` 并对每个 arg 做 Windows quoting,需 Windows 实测 → DEFER。
      child = spawn(input.cmd, [...input.args], {
        cwd: input.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 新进程组(POSIX),超时整组终止,后台后代不成孤儿持管道(见 processTreeKillable)。
        detached: TREE_KILL_DETACHED,
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
    const proc = child;
    inFlight.add(proc);
    if (senderId !== undefined) {
      inFlightBySender.set(senderId, (inFlightBySender.get(senderId) ?? 0) + 1);
    }
    // close / error 可能先后都到:只释放一次名额。
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight.delete(proc);
      if (senderId === undefined) return;
      const n = (inFlightBySender.get(senderId) ?? 1) - 1;
      if (n > 0) inFlightBySender.set(senderId, n);
      else inFlightBySender.delete(senderId);
    };
    proc.once('close', release);
    proc.once('error', release);
    if (senderId !== undefined) trackPluginShellProcess(proc, senderId, input.pluginId);

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

    // 一次性非交互 API:无论有无 input 都要 end stdin。旧实现只在有 input 时 end,
    // 无 input 时管道一直开着 → cat / python - 等读 stdin 的命令永远等不到 EOF,
    // 卡到超时被 SIGTERM。
    if (child.stdin) {
      // 子进程不读 stdin / 写入前就退出时,向已关闭的管道写会在 stdin 流上发
      // 'error'(EPIPE)。stdin 是独立 emitter,'error' 无监听者会上抛为
      // uncaughtException;electron/main 没有任何 uncaughtException 兜底 →
      // 一次 EPIPE 崩溃整个主进程(所有窗口 + 未保存状态全丢)。挂 'error'
      // 监听吞掉,并 try/catch 同步 write/end(进程已退出的边界)。
      child.stdin.on('error', () => {
        /* EPIPE / 管道已关闭:子进程不读 stdin,忽略,exit/close 会照常 resolve */
      });
      try {
        if (input.input !== undefined) child.stdin.write(input.input);
        child.stdin.end();
      } catch {
        /* 已关闭的 stdin 同步抛错:同样忽略,交给 close/error 收尾 */
      }
    }

    // 注:SIGKILL 升级不得以 `child.killed` 判定 —— 它在 `kill('SIGTERM')` 成功**发出信号**后即为 true
    // (Node 语义:killed = 信号已发送,非进程已退出),曾让 SIGKILL 分支永不执行(审计 P1)。
    // 超时后宽限期的整组 SIGKILL 不随结算取消:整组 SIGTERM 后直接子进程先退出 → close → settle,
    // 若此时清掉它,同组内忽略 SIGTERM 且不持管道的后代会存活成孤儿。故一经发起进程树终止,宽限期满
    // 无论直接子进程是否已退出都对整组 SIGKILL(组已不存在 ESRCH 由 processTreeKillable 吞掉)。
    // timer 仅在超时后才挂、最多 SIGKILL_GRACE_MS 且 unref,不阻止进程退出(P2-AP 的资源顾虑有界)。
    let forceTimer: NodeJS.Timeout | null = null;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = null;
      }
    };
    // 超时终止整棵进程树(只杀直接子进程时后台后代持管道 → close 不来 → Promise 挂住)。
    const tree = processTreeKillable(child);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        tree.kill('SIGTERM');
      } catch { /* */ }
      // grace period 后整组 SIGKILL(不看直接子进程是否已退出,见上 clearTimers 注释)
      const killTimer = setTimeout(() => {
        try {
          tree.kill('SIGKILL');
        } catch { /* */ }
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
      // 仍等不到 close(后代逃出进程组仍持管道)→ 销毁 stdio 强制结算,不无限等待。
      forceTimer = setTimeout(() => {
        forceTimer = null;
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(child.exitCode, child.signalCode);
      }, FORCE_SETTLE_MS);
      forceTimer.unref?.();
    }, timeoutMs);

    child.on('error', (err) => {
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

    function settle(code: number | null, signal: NodeJS.Signals | null): void {
      clearTimers();
      resolve({
        stdout: decode(stdoutChunks),
        stderr: decode(stderrChunks),
        exitCode: code,
        signal: typeof signal === 'string' ? signal : null,
        timedOut,
        truncated,
      });
    }
    child.on('close', settle);
  });
}

// shell.openExternal 白名单 scheme:仅 http/https/mailto。其他 scheme
// (如 javascript:、custom://)拒绝,防止恶意 markdown 通过 [text](javascript:...)
// 在主机执行任意代码 / 触发 protocol handler。Electron 文档同款建议。
//
// scheme 白名单(不含 file:,安全 S6)见 shared/url-limits.startsWithAllowedExternalScheme(与 renderer 共用)。
/**
 * 是否允许把该 URL 交给系统打开。所有调用 `shell.openExternal` 的入口都必须先过
 * 这个白名单 —— 包括 `windowOpenHandler` 的 deny 分支(`target="_blank"` 锚点点击,
 * 如 marketplace 的不受信 `authorUrl` / 评论 `url`)。共享同一断言,避免某个入口
 * 漏接白名单成为协议处理器投放面。
 */
export function isAllowedExternalUrl(url: string): boolean {
  return startsWithAllowedExternalScheme(url);
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
