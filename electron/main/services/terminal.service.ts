// PTY service(M-Terminal Step T1,从 MindAutonAgent 移植)。
// SessionManager session map<id, Instance>;输出节流 / 截断 / overflow 通知;
// kill grace period 3s 优雅终止。

import { BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import {
  prepareShellIntegrationEnv,
  SessionManager,
} from '@continuo-terminal/server-node';
import * as terminalSessions from './terminal-sessions.service';
import { mcpRevokers } from './mcp-host.service';
import { getCurrentLocale } from './settings.service';
import { withPtyLangEnv } from './pty-lang';

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

  inst.bytesPerSecond += chunk.length;

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
    maxBytes: 64 * 1024,
  });
  return sessionManager;
}

// Per-session WebContents routing (P0-2 fix from red-team-v3)
const sessionTargets = new Map<string, WebContents>();

function setTarget(id: string, target: WebContents): void {
  sessionTargets.set(id, target);
}

function getTarget(id: string): WebContents | undefined {
  return sessionTargets.get(id);
}

// Variadic safeSend — baseline IPC contract preserved (P0-1 fix)
function safeSend(id: string, channel: string, ...args: unknown[]): void {
  const target = sessionTargets.get(id);
  if (!target || target.isDestroyed()) return;
  target.send(channel, ...args);
}

// Test-only reset (P1-5 fix from red-team-v3)
export function __resetForTest(): void {
  if (sessionManager) {
    // 简单 reset:清掉 maps;不调 cleanupSessionLocal (会在 Op2b 后改成能 catch)
    instances.clear();
  }
  sessionManager = null;
  sessionTargets.clear();
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

// ── 纯函数(可单测,export)─────────────────────────────────────

/**
 * 超出 maxBytes 时只保留尾部,前置 ANSI reset 防色码脏话。
 * 在尾部窗口 32 字节内向前找 ESC(0x1b),从那里截断 — 防 ANSI escape
 * 序列(如 `\x1b[31m`)被切成两半成乱码。
 */
export function safeTruncate(data: string, maxBytes: number): string {
  if (data.length <= maxBytes) return data;

  let cutPoint = data.length - maxBytes;
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

  return '\x1b[0m' + data.slice(cutPoint);
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
  const { env: shellEnv, cleanup: shellCleanup } = await prepareShellIntegrationEnv(
    shell,
    baseEnvWithLang,
  );
  // 强制 login + interactive shell:对齐 iTerm 默认行为 (`exec -l zsh`)。
  // 没 -l/-i 时 zsh 偶发不启 ZLE → zsh-autosuggestions 等 widget plugin 失效。
  // 用户传 args 优先,只在用户没传时加默认 flag。
  const finalArgs = args.length === 0 ? ['-l', '-i'] : args;
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
    inst.bytesPerSecond = 0;
  }, THROTTLE_RESET_INTERVAL_MS);

  try {
    // PHASE 2: spawn PTY via SessionManager.
    await getSessionManager().create({
      session_id: id,
      shell,
      args: finalArgs,
      env: shellEnv as Record<string, string>,
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

export function write(id: string, data: string): boolean {
  const inst = instances.get(id);
  if (!inst) return false;
  void getSessionManager()
    .sendInput({ session_id: id, data })
    .catch((err) => warnOnce(`sendInput:${id}`, `sendInput failed for ${id}: ${(err as Error).message}`));
  return true;
}

export function resize(id: string, cols: number, rows: number): boolean {
  const inst = instances.get(id);
  if (!inst) return false;
  void getSessionManager()
    .resize({ session_id: id, cols, rows })
    .catch((err) => warnOnce(`resize:${id}`, `resize failed for ${id}: ${(err as Error).message}`));
  return true;
}

export function interrupt(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  void getSessionManager()
    .sendInput({ session_id: id, data: '\x03' })
    .catch((err) => warnOnce(`interrupt:${id}`, `interrupt failed for ${id}: ${(err as Error).message}`));
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

/** 主进程退出前调,kill 所有 PTY 防 zombie. */
export function cleanupAll(): void {
  const ids = Array.from(instances.keys());
  for (const id of ids) {
    kill(id);
  }
}
