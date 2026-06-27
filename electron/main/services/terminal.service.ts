// PTY service(M-Terminal Step T1,从 MindAutonAgent 移植)。
// SessionManager session map<id, Instance>;输出节流 / 截断 / overflow 通知;
// kill grace period 3s 优雅终止。

import { app, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import path from 'node:path';
import {
  prepareShellIntegrationEnv,
  SessionManager,
} from '@continuo-terminal/server-node';
import * as terminalSessions from './terminal-sessions.service';
import { mcpRevokers } from './mcp-host.service';
import { getCurrentLocale } from './settings.service';
import { withPtyLangEnv } from './pty-lang';
import { defaultShellArgs } from './shell-args';
import { utf8ByteLength } from '../../shared/utf8-byte-length';

// ── 常量(节流参数,沿用 Mind 决策 #5)──────────────────────────
const OVERFLOW_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB/s 触发 overflow
const TRUNCATE_MAX_BYTES = 64 * 1024;             // overflow 时单 chunk 上限
const FLUSH_DELAY_OVERFLOW_MS = 100;
const FLUSH_DELAY_INPLACE_MS = 64;
const FLUSH_DELAY_DEFAULT_MS = 32;
const THROTTLE_RESET_INTERVAL_MS = 1_000;
const KILL_GRACE_PERIOD_MS = 3_000;

function handleChunk(id: string, chunk: string): void {
  const inst = instances.get(id);
  if (!inst) return;

  const flush = () => {
    if (inst.pendingData) {
      safeSend(id, 'terminal:data', id, inst.pendingData);
      inst.pendingData = '';
    }
    inst.flushTimer = null;
  };

  // 边界(E149,E125 同族):按真实 UTF-8 字节计 overflow 节流(非 chunk.length=UTF-16 code unit),
  // 否则大量 CJK/emoji 输出真实字节数倍超 2MiB/s 仍不触发 overflow,IPC/renderer 输出膨胀。
  inst.bytesPerSecond += utf8ByteLength(chunk);

  const isOverflow = inst.bytesPerSecond > OVERFLOW_THRESHOLD_BYTES;
  if (isOverflow) {
    inst.pendingData = safeTruncate(
      inst.pendingData + chunk,
      TRUNCATE_MAX_BYTES,
    );
    if (!inst.overflowNotified) {
      inst.overflowNotified = true;
      safeSend(id, 'terminal:overflow', id);
    }
    if (!inst.flushTimer) {
      inst.flushTimer = setTimeout(flush, FLUSH_DELAY_OVERFLOW_MS);
    }
    return;
  }

  if (inst.overflowNotified) {
    inst.overflowNotified = false;
    safeSend(id, 'terminal:overflow-recovered', id);
  }
  inst.pendingData += chunk;

  if (!inst.flushTimer) {
    const delay = isInPlaceUpdate(chunk)
      ? FLUSH_DELAY_INPLACE_MS
      : FLUSH_DELAY_DEFAULT_MS;
    inst.flushTimer = setTimeout(flush, delay);
  }
}

function handleExit(id: string, info: { exitCode: number; signal?: number }): void {
  // SessionManager constructor onExit callback fires when PTY naturally exits.
  // forceKill/killTimer-grace/cleanupAllForWindow paths sync-call cleanupSessionLocal
  // BEFORE sm.kill (which disposes this listener), so this handler is the idempotent
  // fallback for natural exits.
  // Note: signal is currently dropped at the IPC boundary (baseline 'terminal:exit'
  // payload uses { exitCode, signal }, our cleanupSessionLocal also uses
  // { exitCode, signal: undefined }) — Op4/Op12 review may wire signal through if
  // baseline preserves it; for now cleanupSessionLocal preserves baseline shape.
  cleanupSessionLocal(id, info.exitCode);
}

// SessionManager singleton (lazy init)
let sessionManager: SessionManager | null = null;

function getSessionManager(): SessionManager {
  if (sessionManager) return sessionManager;
  sessionManager = new SessionManager({
    onData: handleChunk,
    onExit: handleExit,
    // 4 MiB: 恢复 @continuo-terminal/server-node 的库默认 MAX_BUFFER_BYTES。
    // 此前压到 64KiB 会让较长的 agent 报告(codex 等)在 terminal_read_output
    // 读取前就被环形缓冲 FIFO 丢弃(truncated)。容量按字节/每会话计。
    maxBytes: 4 * 1024 * 1024,
  });
  return sessionManager;
}

// Per-session WebContents routing (P0-2 fix from red-team-v3)
const sessionTargets = new Map<string, WebContents>();

function setTarget(id: string, target: WebContents): void {
  sessionTargets.set(id, target);
}

// Variadic safeSend — baseline IPC contract preserved (P0-1 fix)
function safeSend(id: string, channel: string, ...args: unknown[]): void {
  const target = sessionTargets.get(id);
  if (!target || target.isDestroyed()) return;
  // race(R71):isDestroyed() 检查后、send 前 webContents 可能销毁,send 抛 "Object has been
  // destroyed"。safeSend 由 PTY onData/flush timer/exit 回调调用 —— 尤其 handleChunk 的 flush
  // 闭包:若 send 抛,后面的 `pendingData=''` + `flushTimer=null` 都不执行 → 下个 chunk 因
  // flushTimer 仍非空(但已 fire)不再调度 setTimeout → 终端面板永久卡在旧输出;且在 setTimeout/
  // 事件回调里成主进程未捕获异常(崩溃/噪声)。名为 safeSend 必须真正"安全":send 包 try/catch,
  // 失败只 warnOnce 不冒泡,保证调用方(flush)继续清 pending/timer。后续 send 由上面的
  // isDestroyed() 检查短路(销毁的 webContents isDestroyed() 返 true),无需显式删 target。
  // 镜像广播族 R62-R70 的「投递失败不冒泡」。
  try {
    target.send(channel, ...args);
  } catch (err) {
    warnOnce(`safeSend:${id}`, `send to destroyed target failed: ${String(err)}`);
  }
}

// Test-only reset (P1-5 fix from red-team-v3)
export function __resetForTest(): void {
  if (sessionManager) {
    // 简单 reset:清掉 maps;不调 cleanupSessionLocal (会在 Op2b 后改成能 catch)
    instances.clear();
  }
  sessionManager = null;
  sessionTargets.clear();
  resizeChains.clear();
}

/**
 * Pull-based raw byte snapshot for IPC renderer attach (terminal:read_history).
 * Maps server-node SESSION_NOT_FOUND → empty (NEED-INFO-1=b decision: baseline
 * readRaw behavior on missing buffer was {data:'', truncated:false}).
 * truncated=true → prefix '\x1b[0m' to reset any retained CSI/OSC tail (P1-1).
 */
export function getBufferSnapshot(id: string): { data: string; truncated: boolean } {
  const sm = getSessionManager();
  try {
    const snapshot = sm.getBufferSnapshot(id);
    const data = snapshot.truncated ? '\x1b[0m' + snapshot.data : snapshot.data;
    return { data, truncated: snapshot.truncated };
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e?.code === 'SESSION_NOT_FOUND') {
      return { data: '', truncated: false };
    }
    throw err;
  }
}

/**
 * Async line-based read for MCP terminal.read_output tool.
 * Returns camelCase {data, lines, nextSeq, truncated} (library convention; deps expect this).
 * SESSION_NOT_FOUND → rethrow with code='TERMINAL_SESSION_NOT_FOUND' preserving cause.
 */
export async function readOutput(
  id: string,
  opts: { sinceSeq?: number; maxLines?: number; stripAnsi?: boolean },
): Promise<{ data: string; lines: string[]; nextSeq: number; truncated: boolean }> {
  const sm = getSessionManager();
  try {
    const r = await sm.readOutput({
      session_id: id,
      since_seq: opts.sinceSeq,
      max_lines: opts.maxLines,
      strip_ansi: opts.stripAnsi,
    });
    return { data: r.data, lines: r.lines, nextSeq: r.next_seq, truncated: r.truncated };
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e?.code === 'SESSION_NOT_FOUND') {
      const wrapped = new Error(e.message, { cause: e }) as Error & { code: string };
      wrapped.code = 'TERMINAL_SESSION_NOT_FOUND';
      throw wrapped;
    }
    throw err;
  }
}

// warnOnce — keyed by `${channel}:${msgKey}` to avoid swallowing cross-session errors (P2-2)
const _warnedKeys = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  console.warn(`[terminal.service] ${msg}`);
}

// cleanupSessionLocal — idempotent local cleanup for Continuo-side state.
// Called sync BEFORE sm.kill (force/grace/window-close paths) because sm.kill
// disposes SessionManager onExit listener immediately (P0-1 fix from red-team-v3).
// Also called by SessionManager onExit handler for natural PTY exit (idempotent
// fallback — second call returns early since instances.has(id) === false).
function cleanupSessionLocal(id: string, exitCode: number): void {
  const instance = instances.get(id);
  if (!instance) return; // idempotent — already cleaned

  // 1. Mark exited in metadata
  try {
    terminalSessions.setExited(id, exitCode);
  } catch (err) {
    warnOnce(`setExited:${id}`, `terminalSessions.setExited threw for ${id}: ${(err as Error).message}`);
  }

  // 1b. Flush any buffered output BEFORE the exit event. cleanupSessionLocal
  // clears flushTimer below (step 3) without firing it, so the last chunk still
  // sitting in the throttle window (often the command's final result / exit
  // banner) would otherwise be silently dropped. Emit it first so the renderer
  // sees data → exit in order. (审计 #1)
  if (instance.pendingData) {
    safeSend(id, 'terminal:data', id, instance.pendingData);
    instance.pendingData = '';
  }

  // 2. Push terminal:exit (only if target still alive — variadic baseline payload)
  // Baseline shape: webContents.send('terminal:exit', id, { exitCode, signal })
  safeSend(id, 'terminal:exit', id, { exitCode, signal: undefined });

  // 3. Clear all timers (Adjustment A: throttleInterval was setInterval per Op0 baseline)
  if (instance.killTimer) {
    clearTimeout(instance.killTimer);
    instance.killTimer = null;
  }
  if (instance.flushTimer) {
    clearTimeout(instance.flushTimer);
    instance.flushTimer = null;
  }
  if (instance.throttleInterval) {
    clearInterval(instance.throttleInterval);
    instance.throttleInterval = null;
  }

  // 4. Continuo-specific cleanup (shellCleanup is async — P1-1 fix)
  try {
    const cleanupResult = instance.shellCleanup?.();
    if (cleanupResult && typeof (cleanupResult as Promise<unknown>).catch === 'function') {
      void (cleanupResult as Promise<unknown>).catch((err) =>
        warnOnce(`shellCleanup:${id}`, `shellCleanup rejected for ${id}: ${(err as Error).message}`),
      );
    }
  } catch (err) {
    warnOnce(`shellCleanup-sync:${id}`, `shellCleanup threw sync for ${id}: ${(err as Error).message}`);
  }

  if (instance.mcpToken) {
    try {
      mcpRevokers().byToken(instance.mcpToken);
    } catch (err) {
      warnOnce(`mcpRevoke:${id}`, `mcpToken revoke threw for ${id}: ${(err as Error).message}`);
    }
  }

  // 5. Remove from all maps (finally-style — even if above threw)
  instances.delete(id);
  sessionTargets.delete(id);
  resizeChains.delete(id); // race(R17):清 resize 串行链,防 session 关闭后泄漏
}

interface Instance {
  pendingData: string;
  flushTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  bytesPerSecond: number;
  throttleInterval: NodeJS.Timeout | null;
  overflowNotified: boolean;
  readonly mcpToken: string;
  readonly shellCleanup: () => Promise<void>;
}

const instances = new Map<string, Instance>();
// race(R17):per-session resize 串行链。连续 resize IPC 各自启动 SessionManager.resize() 不
// 串行,底层 Promise 可能乱序完成 —— 较早的小尺寸若晚于较新的大尺寸完成,会把 PTY 行列数回退
// 到旧值(UI 已按最新尺寸渲染但 PTY 停在旧 cols/rows → 换行/全屏 TUI/光标错乱)。经此链按调用
// 顺序串行应用,最新一次自然最后生效(last-wins,不回退)。
const resizeChains = new Map<string, Promise<void>>();

// ── 纯函数(可单测,export)─────────────────────────────────────

/**
 * 超出 maxBytes 时只保留尾部,前置 ANSI reset 防色码脏话。
 * 在尾部窗口 32 字节内向前找 ESC(0x1b),从那里截断 — 防 ANSI escape
 * 序列(如 `\x1b[31m`)被切成两半成乱码。
 */
// 边界(E244):前置的 ANSI reset(`\x1b[0m`)是 4 个 ASCII 字节。截断预算须先扣除它,否则返回值
// (reset + 尾部数据)真实字节数 = maxBytes + 4,违反"≤ maxBytes"契约(小上限/通用复用时明显超限)。
const RESET_PREFIX = '\x1b[0m';
const RESET_PREFIX_BYTES = 4;

export function safeTruncate(data: string, maxBytes: number): string {
  // 边界(E149,E125 同族):按真实 UTF-8 字节判定/截断(旧实现 data.length=UTF-16 code unit →
  // 多字节输出保留远超 maxBytes 字节)。从尾部累积字节,找保留 ≤ maxBytes 字节的最早**字符边界**。
  if (utf8ByteLength(data) <= maxBytes) return data;

  // 边界(E244):预算扣除 reset 前缀字节,使最终返回值(reset + slice)总字节 ≤ maxBytes。
  // maxBytes < 前缀字节(4)时预算为 0 → 仅返回 reset(此退化场景无法更小,前缀本身即 4 字节)。
  const budget = Math.max(0, maxBytes - RESET_PREFIX_BYTES);
  let bytes = 0;
  let cutPoint = data.length;
  for (let i = data.length - 1; i >= 0; ) {
    let step = 1;
    let cp = data.charCodeAt(i);
    // 低代理:与前一个高代理合成 astral code point(4 bytes,消费 2 code unit)。
    if (cp >= 0xdc00 && cp <= 0xdfff && i > 0) {
      const hi = data.charCodeAt(i - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) {
        cp = 0x10000;
        step = 2;
      }
    }
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp >= 0x10000 ? 4 : 3;
    if (bytes + b > budget) break; // 边界(E244):用扣除 reset 前缀后的预算
    bytes += b;
    cutPoint = i - step + 1;
    i -= step;
  }

  // ANSI 边界(同原逻辑):cutPoint 落在不完整 ESC 序列起点则回退到 ESC 前,防半截色码。
  const searchStart = Math.max(0, cutPoint - 32);
  for (let i = cutPoint; i >= searchStart; i--) {
    if (data.charCodeAt(i) === 0x1b) {
      const slice = data.slice(i, cutPoint + 1);
      // eslint-disable-next-line no-control-regex
      if (!/\x1b\[[\d;]*[A-Za-z]/.test(slice)) {
        cutPoint = i;
      }
      break;
    }
  }

  return RESET_PREFIX + data.slice(cutPoint);
}

/**
 * 检测 ANSI 光标移动 / 清行 / 定位类控制序列(说明这是"原地更新"
 * 而非新增输出),且数据本身较短(< 512 字节)。用于 flush 节流:
 * in-place 更新延后到 64ms 降帧率,避免大量重绘抖动。
 */
export function isInPlaceUpdate(data: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /\x1b\[\d*[ABCDGHK]/.test(data) && data.length < 512;
}

// ── PTY 生命周期 ──────────────────────────────────────────────

export async function createTerminal(
  id: string,
  win: BrowserWindow,
  shell: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  meta?: { mcpToken?: string },
): Promise<void> {
  if (instances.has(id)) {
    throw new Error(`Terminal id "${id}" already exists`);
  }

  const baseEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // 显式声明终端身份,让用户 .zshrc / .bashrc 能区分 Continuo 与 iTerm。
    // 不显式设的话以下变量会从启动 Continuo 的父进程继承(常见 iTerm),
    // 用户的 if [[ TERM_PROGRAM == iTerm.app || LC_TERMINAL == iTerm2 ]]
    // 会误判,加载 powerline 主题而 Continuo xterm.js 调色板对不上 → light
    // 模式下 segment 黑底黑字。两个都得覆盖,||  任一命中就误判。
    TERM_PROGRAM: 'Continuo',
    LC_TERMINAL: 'Continuo',
    ...env,
  };
  const baseEnvWithLang = withPtyLangEnv(
    baseEnv as Record<string, string | undefined>,
    getCurrentLocale(),
  );
  let shellEnv: Awaited<ReturnType<typeof prepareShellIntegrationEnv>>['env'];
  let shellCleanup: Awaited<
    ReturnType<typeof prepareShellIntegrationEnv>
  >['cleanup'];
  try {
    ({ env: shellEnv, cleanup: shellCleanup } = await prepareShellIntegrationEnv(
      shell,
      baseEnvWithLang,
    ));
  } catch (err) {
    // prepareShellIntegrationEnv 在 PHASE 1 try 之外,失败(写 shell integration 脚本时
    // 磁盘满 / 权限 / ENOENT)会绕过下面的 sm.create rollback。此刻 mcpToken 已在 ipc 层
    // 签发(注入 windowTokens),但尚未分配其它资源 → 撤销它防孤儿 token 泄漏 + map 增长。
    // 见第十九轮 P2-AW。
    if (meta?.mcpToken) {
      try {
        mcpRevokers().byToken(meta.mcpToken);
      } catch {
        // ignore rollback cleanup errors
      }
    }
    throw err;
  }
  const hookEventsDir = path.join(app.getPath('userData'), 'hook-events');
  const envWithHookEvents = {
    ...shellEnv,
    CONTINUO_HOOK_EVENTS_DIR: hookEventsDir,
  };
  // 强制 login + interactive shell:对齐 iTerm 默认行为 (`exec -l zsh`)。
  // 没 -l/-i 时 zsh 偶发不启 ZLE → zsh-autosuggestions 等 widget plugin 失效。
  // 用户传 args 优先,只在用户没传时加默认 flag。
  // 跨平台:`-l -i` 是 POSIX 交互 shell 语义,Windows powershell/cmd 不识别会启动失败,
  // /bin/sh(dash)/ 未知 shell 也未必支持 → defaultShellArgs 仅对 zsh/bash/fish 追加。
  const finalArgs = args.length === 0 ? defaultShellArgs(shell) : args;
  const inst: Instance = {
    pendingData: '',
    flushTimer: null,
    killTimer: null,
    bytesPerSecond: 0,
    throttleInterval: null,
    overflowNotified: false,
    mcpToken: meta?.mcpToken ?? '',
    shellCleanup,
  };

  // PHASE 1: register all Continuo-side state BEFORE PTY spawn.
  instances.set(id, inst);
  setTarget(id, win.webContents);
  inst.throttleInterval = setInterval(() => {
    // overflow 后若流恰好静默(不再有 chunk),handleChunk 的 recover 分支没机会跑
    // → renderer 永久卡在 overflow 指示。这里在速率回落到阈值内时补发 recovered。
    // (handleChunk 收到低于阈值的 chunk 时已会清 overflowNotified,故无重复发送。)
    if (inst.overflowNotified && inst.bytesPerSecond <= OVERFLOW_THRESHOLD_BYTES) {
      inst.overflowNotified = false;
      safeSend(id, 'terminal:overflow-recovered', id);
    }
    inst.bytesPerSecond = 0;
  }, THROTTLE_RESET_INTERVAL_MS);

  try {
    // PHASE 2: spawn PTY via SessionManager.
    await getSessionManager().create({
      session_id: id,
      shell,
      args: finalArgs,
      env: envWithHookEvents as Record<string, string>,
      cwd,
      cols: 120,
      rows: 40,
      name: shell,
    });
  } catch (err) {
    // PHASE 3: rollback all PHASE 1 state on sm.create failure.
    instances.delete(id);
    sessionTargets.delete(id);
    if (inst.throttleInterval) {
      clearInterval(inst.throttleInterval);
      inst.throttleInterval = null;
    }
    if (inst.mcpToken) {
      try {
        mcpRevokers().byToken(inst.mcpToken);
      } catch {
        // ignore rollback cleanup errors
      }
    }
    try {
      void inst.shellCleanup().catch(() => {
        // ignore rollback cleanup errors
      });
    } catch {
      // ignore rollback cleanup errors
    }
    throw err;
  }
}

export function has(id: string): boolean {
  return instances.has(id);
}

// race(R4):必须 await sendInput 并把真实结果上抛。此前 fire-and-forget 恒返 true → IPC 恒
// ok:true,即使 PTY 在 instances.get(id) 与实际 sendInput 之间退出 / server-node 拒绝写入,
// renderer 也收到假成功 —— 用户输入在终端退出/重启边界被静默丢弃,前端 A144 的 r.ok 检查失效。
export async function write(id: string, data: string): Promise<boolean> {
  const inst = instances.get(id);
  if (!inst) return false;
  try {
    await getSessionManager().sendInput({ session_id: id, data });
    return true;
  } catch (err) {
    warnOnce(`sendInput:${id}`, `sendInput failed for ${id}: ${(err as Error).message}`);
    return false;
  }
}

export async function resize(
  id: string,
  cols: number,
  rows: number,
): Promise<boolean> {
  const inst = instances.get(id);
  if (!inst) return false;
  // race(R17):把本次 resize 接到该 session 的串行链尾 —— 保证按调用顺序应用到 PTY,避免乱序
  // 完成导致旧尺寸覆盖新尺寸。链尾吞错,前次失败不阻断后续 resize。
  // race(R96):此前 fire-and-forget 恒返 true,PTY resize 失败只 warn → renderer 无从感知,
  // 误以为该尺寸已同步、后续同尺寸不重试 → xterm DOM 与 PTY 尺寸长期不一致(TUI 错乱)。改为
  // 等本次 resize 在串行链中的真实结果并上抛(true/false)。链尾仍保持 void+吞错供后续串行,
  // 本调用单独返回自己这次的布尔结果。
  const prev = resizeChains.get(id) ?? Promise.resolve();
  const task = prev.then(() =>
    getSessionManager()
      .resize({ session_id: id, cols, rows })
      .then(
        () => true,
        (err) => {
          warnOnce(
            `resize:${id}`,
            `resize failed for ${id}: ${(err as Error).message}`,
          );
          return false;
        },
      ),
  );
  resizeChains.set(
    id,
    task.then(() => undefined),
  );
  return task;
}

// race(R12,R4 同族):await Ctrl-C 写入并上抛真实结果。此前 fire-and-forget 恒「成功」→ IPC
// 在实际中断前返回成功,PTY 检查后退出 / 写入失败时中断静默丢失,用户/agent 以为已中断但
// 进程可能继续跑。返回 false 让 IPC handler 上抛供 renderer 感知。
export async function interrupt(id: string): Promise<boolean> {
  const inst = instances.get(id);
  if (!inst) return false;
  try {
    await getSessionManager().sendInput({ session_id: id, data: '\x03' });
    return true;
  } catch (err) {
    warnOnce(`interrupt:${id}`, `interrupt failed for ${id}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * 优雅终止:先发 Ctrl+C,3s 后 force kill。
 * 重复调 kill 同 id 不会重复设 timer。
 */
export function kill(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.killTimer) return;

  // Step 1: send Ctrl+C immediately (replaces baseline pty.write('\x03')).
  void getSessionManager()
    .sendInput({ session_id: id, data: '\x03' })
    .catch((err) => warnOnce(`kill-ctrlc:${id}`, `kill Ctrl+C failed for ${id}: ${(err as Error).message}`));

  // Step 2: 3s grace, then SYNC cleanup + sm.kill (P0-1 fix from red-team-v3).
  inst.killTimer = setTimeout(() => {
    inst.killTimer = null;
    cleanupSessionLocal(id, -1);
    void getSessionManager()
      .kill({ session_id: id, signal: 'SIGKILL' })
      .catch((err) => warnOnce(`kill-sigkill:${id}`, `sm.kill SIGKILL failed for ${id}: ${(err as Error).message}`));
  }, KILL_GRACE_PERIOD_MS);
}

/**
 * P4 — SIGKILL 强杀:跳过 grace period,直接 pty.kill('SIGKILL')。
 * 撤销已设的 grace timer(若有),避免重复 kill。
 * onExit 由 PTY 自然触发 → setExited + cleanup 走现有流程。
 */
export function forceKill(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.killTimer) {
    clearTimeout(inst.killTimer);
    inst.killTimer = null;
  }
  // SYNC cleanup BEFORE sm.kill (P0-1 fix).
  // exitCode -1 is deliberate: force-killed PTYs don't deliver a natural exit code.
  cleanupSessionLocal(id, -1);
  void getSessionManager()
    .kill({ session_id: id, signal: 'SIGKILL' })
    .catch((err) => warnOnce(`forceKill:${id}`, `forceKill failed for ${id}: ${(err as Error).message}`));
}

/**
 * 主进程退出前调,force-kill 所有 PTY 防 zombie(尤其 agent 跑的长任务子进程)。
 * 必须用 forceKill(立即 SIGKILL)而非 kill():后者把 SIGKILL 放进 3s grace timer,
 * 进程退出时 timer 永不 fire → 只发了 Ctrl+C 杀不掉忽略 SIGINT 的进程(审计 P1)。
 * 返回 await 所有 SIGKILL 完成的 promise,供 before-quit 在 app.quit() 前等待。
 */
export async function cleanupAll(): Promise<void> {
  const ids = Array.from(instances.keys());
  if (ids.length === 0) return; // 没开过终端就别 lazy-init SessionManager
  const sm = getSessionManager();
  await Promise.all(
    ids.map(async (id) => {
      const inst = instances.get(id);
      if (inst?.killTimer) {
        clearTimeout(inst.killTimer);
        inst.killTimer = null;
      }
      // 同步本地拆除(timers / listeners / mcp token revoke),exitCode -1。
      cleanupSessionLocal(id, -1);
      try {
        await sm.kill({ session_id: id, signal: 'SIGKILL' });
      } catch {
        // 进程正在退出,忽略 kill race。
      }
    }),
  );
}
