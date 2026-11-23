// PTY service(M-Terminal Step T1,从维护者早期原型移植)。
// SessionManager session map<id, Instance>;输出节流 / 截断;
// kill grace period 3s 优雅终止。

import { app, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';
import {
  prepareShellIntegrationEnv,
  SessionManager,
} from '@continuo-terminal/server-node';
import type { ReadOutputInput, ReadOutputOutput } from '../../shared/mcp-terminal-schemas';
import * as terminalSessions from './terminal-sessions.service';
import { mcpRevokers } from './mcp-host.service';
import { TERMINAL_SESSION_ENV, hookEventsDirFor } from './mcp-tools-hook-bridge';
import { getCurrentLocale } from './settings.service';
import { withPtyLangEnv } from './pty-lang';
import { defaultShellArgs, skipsShellIntegration } from './shell-args';
import { runSerialPerKey } from './serialize-per-key';
import { utf8ByteLength } from '../../shared/utf8-byte-length';
import { TERMINAL_CHANNELS, type TerminalHistorySnapshot } from '../../shared/terminal-channels';
import { ERROR_CODES } from '../../shared/error-codes';
import { codedError } from '../../shared/error-message';
import { mergeSpawnEnv } from '../lib/child-spawn-hardening';

// ── 常量(节流参数,沿用 Mind 决策 #5)──────────────────────────
const OVERFLOW_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB/s 触发 overflow(截断 + 100ms 合批)
const TRUNCATE_MAX_BYTES = 64 * 1024;             // overflow 时单 chunk 上限
const FLUSH_DELAY_OVERFLOW_MS = 100;
// 合批窗口直接叠加在每次按键回显上:此前 32ms / 原地更新 64ms(zsh 回显几乎都带 `\x1b[K` 等 CSI,
// 走 64ms)可感知输入延迟。对齐 VSCode TerminalDataBufferer 统一 5ms(xterm 本就按帧渲染,
// 主进程再延后原地更新不省重绘)。
const FLUSH_DELAY_MS = 5;
const THROTTLE_RESET_INTERVAL_MS = 1_000;
const KILL_GRACE_PERIOD_MS = 3_000;

// 吞吐窗口用单调时钟:墙钟(Date.now)可被系统校时回拨,窗口长期不滚动 → 回拨后的输出一直按 overflow 截断。
const monotonicNow = (): number => performance.now();

// 把合批窗口里的在途输出发给 renderer,第三个参数 = 本批首字符的累计偏移(见 getBufferSnapshot)。
function flushPending(id: string, inst: Instance): void {
  if (inst.flushTimer) {
    clearTimeout(inst.flushTimer);
    inst.flushTimer = null;
  }
  if (inst.pendingData) {
    safeSend(id, inst, TERMINAL_CHANNELS.DATA, id, inst.pendingData, inst.pendingStart);
    inst.pendingData = '';
  }
}

/**
 * 吞吐窗口惰性滚动(perf):此前每个 PTY 一个永久 1Hz setInterval(上限 256 会话 → 空闲也 256 次/秒唤醒
 * 主进程)清零计数。现改为 chunk 到达时按时间戳补跑错过的 tick,窗口仍以创建时刻对齐、每 1s 一格。
 */
function rollThroughputWindow(inst: Instance, now: number): void {
  const elapsed = now - inst.windowStart;
  if (elapsed < THROTTLE_RESET_INTERVAL_MS) return;
  inst.bytesPerSecond = 0;
  inst.windowStart +=
    Math.floor(elapsed / THROTTLE_RESET_INTERVAL_MS) * THROTTLE_RESET_INTERVAL_MS;
}

function handleChunk(id: string, chunk: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  rollThroughputWindow(inst, monotonicNow());

  if (!inst.pendingData) inst.pendingStart = inst.receivedChars;
  inst.receivedChars += chunk.length;

  // 边界(E149,E125 同族):按真实 UTF-8 字节计 overflow 节流(非 chunk.length=UTF-16 code unit),
  // 否则大量 CJK/emoji 输出真实字节数倍超 2MiB/s 仍不触发 overflow,IPC/renderer 输出膨胀。
  // 原生计数(与 utf8ByteLength 口径一致,单独代理按 3 字节);纯 JS 逐字符在大量输出时慢约 15 倍。
  inst.bytesPerSecond += Buffer.byteLength(chunk, 'utf8');

  const isOverflow = inst.bytesPerSecond > OVERFLOW_THRESHOLD_BYTES;
  if (isOverflow) {
    const merged = inst.pendingData + chunk;
    inst.pendingData = safeTruncate(merged, TRUNCATE_MAX_BYTES);
    // 截断后本批只剩尾部:偏移改为保留尾部的起点(reset 前缀不计),与上一批之间必然留缺口,
    // renderer 的连续性判断(queueCoversSnapshot)据此识别有损批次。
    if (inst.pendingData !== merged) {
      inst.pendingStart =
        inst.receivedChars - (inst.pendingData.length - RESET_PREFIX.length);
    }
    if (!inst.flushTimer) {
      inst.flushTimer = setTimeout(flushPending, FLUSH_DELAY_OVERFLOW_MS, id, inst);
    }
    return;
  }

  inst.pendingData += chunk;

  if (!inst.flushTimer) {
    inst.flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS, id, inst);
  }
}

function handleExit(id: string, info: { exitCode: number; signal?: number }): void {
  // SessionManager constructor onExit callback fires when PTY naturally exits.
  // forceKill/killTimer-grace/makeWindowClosedCleanup paths sync-call cleanupSessionLocal
  // BEFORE sm.kill (which disposes this listener), so this handler is the idempotent
  // fallback for natural exits.
  cleanupSessionLocal(id, info.exitCode);
}

// SessionManager singleton (lazy init)
let sessionManager: SessionManager | null = null;

function getSessionManager(): SessionManager {
  if (sessionManager) return sessionManager;
  sessionManager = new SessionManager({
    onData: handleChunk,
    onExit: handleExit,
    // 1 MiB: 每会话环形缓冲容量(按字节计)。低于此(如曾经的 64KiB)会让较长的
    // agent 报告(codex 等)在 terminal_read_output 读取前就被 FIFO 丢弃(truncated);
    // 1 MiB 是 B3 防回退下限,保留长报告不提前丢的最低保障。
    maxBytes: 1 * 1024 * 1024,
  });
  return sessionManager;
}

// 按会话路由:发给该会话所属窗口的 WebContents(inst.target)。
function safeSend(id: string, inst: Instance, channel: string, ...args: unknown[]): void {
  const target = inst.target;
  if (target.isDestroyed()) return;
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

// 终审 P1:退出清理(cleanupAll)已开始。只杀调用瞬间的快照时,清理期间(debug teardown 数秒、MCP host 关闭前)
// agent 经 terminal.create_session 新建的 PTY 不在快照内,窗口关闭只走 3s grace,主进程退出后升级定时器不执行 →
// 忽略 SIGINT/SIGHUP 的长期命令成为孤儿;故此后 createTerminal 一律拒绝(与 shell exec / debug launch 同一闸)。
let shuttingDown = false;

/** 测试用:复位退出闸(模块级状态)。 */
export function resetTerminalShutdownForTest(): void {
  shuttingDown = false;
}

// 复用 TERMINAL_CREATE_CANCELLED:renderer 用户路径对它静默(退出时窗口已隐藏,无需报错),MCP 侧照常上抛。
function createRejectedQuittingError(): Error {
  return codedError(ERROR_CODES.TERMINAL_CREATE_CANCELLED, 'terminal create rejected: app is quitting');
}

// Test-only reset (P1-5 fix from design review v3)
export function __resetForTest(): void {
  if (sessionManager) {
    // 简单 reset:清掉 maps;不调 cleanupSessionLocal (会在 Op2b 后改成能 catch)
    instances.clear();
  }
  sessionManager = null;
  resizeChains.clear();
  exitedHistories.clear();
  unsubExitedHistoryPrune?.();
  unsubExitedHistoryPrune = null;
}

/**
 * Pull-based raw byte snapshot for IPC renderer attach (terminal:read_history).
 * Maps server-node SESSION_NOT_FOUND → empty (NEED-INFO-1=b decision: baseline
 * readRaw behavior on missing buffer was {data:'', truncated:false}).
 * truncated=true → prefix '\x1b[0m' to reset any retained CSI/OSC tail (P1-1).
 *
 * 历史与实时流衔接:先把合批窗口里的在途输出立即发出(偏移 < endOffset),再取快照 → 此后每批推送
 * 的偏移都 ≥ endOffset,不会有一批横跨快照边界。renderer 据此丢弃已含于快照的推送,避免同段输出写
 * 两次。PTY 输出入 ring buffer 与 handleChunk 在同一同步回调里,故此刻快照恰好止于 receivedChars。
 */
export function getBufferSnapshot(id: string): TerminalHistorySnapshot {
  const sm = getSessionManager();
  const inst = instances.get(id);
  if (inst) flushPending(id, inst);
  else {
    const retained = exitedHistories.get(id);
    if (retained) return retained;
  }
  try {
    const snapshot = sm.getBufferSnapshot(id);
    const data = snapshot.truncated ? '\x1b[0m' + snapshot.data : snapshot.data;
    // startOffset:快照首字符的累计偏移(ring buffer 挤掉最旧数据后不从 0 开始;reset 前缀不计入)。
    return inst
      ? {
          data,
          truncated: snapshot.truncated,
          endOffset: inst.receivedChars,
          startOffset: inst.receivedChars - snapshot.data.length,
        }
      : { data, truncated: snapshot.truncated };
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e?.code === 'SESSION_NOT_FOUND') {
      return { data: '', truncated: false };
    }
    throw err;
  }
}

// PTY 退出后 server-node 立即删 ring buffer,而会话 metadata 进入 exited-retained 继续显示 tab。
// 退出时留一份最后快照,供从没打开过的(agent inactive panel)tab 回放;随 metadata 删除释放。
// 见 src/__tests__/terminal-exited-history。
const MAX_EXITED_HISTORIES = 16;
// 带退出时的 endOffset:挂载回放恰逢退出时,渲染端排队的退出前推送已含于快照,须照常按偏移丢弃。
const exitedHistories = new Map<string, TerminalHistorySnapshot>();
let unsubExitedHistoryPrune: (() => void) | null = null;

function pruneExitedHistories(): void {
  for (const id of exitedHistories.keys()) {
    if (!terminalSessions.get(id)) exitedHistories.delete(id);
  }
  if (exitedHistories.size === 0 && unsubExitedHistoryPrune) {
    unsubExitedHistoryPrune();
    unsubExitedHistoryPrune = null;
  }
}

function retainExitedHistory(id: string): void {
  // metadata 已删(关 tab / 关窗口触发的 kill)→ 无 tab 可回放,不保留。
  if (!terminalSessions.get(id)) return;
  let snapshot: ReturnType<typeof getBufferSnapshot>;
  try {
    snapshot = getBufferSnapshot(id);
  } catch {
    return;
  }
  if (!snapshot.data) return;
  exitedHistories.delete(id);
  exitedHistories.set(id, snapshot);
  if (exitedHistories.size > MAX_EXITED_HISTORIES) {
    const oldest = exitedHistories.keys().next().value;
    if (oldest !== undefined) exitedHistories.delete(oldest);
  }
  unsubExitedHistoryPrune ??= terminalSessions.subscribe(pruneExitedHistories);
}

export const MAX_EXITED_HISTORIES_FOR_TEST = MAX_EXITED_HISTORIES;

/**
 * Async line-based read for MCP terminal.read_output tool:入参出参就是兄弟包的协议类型(与工具契约同形,不做命名转换)。
 * SESSION_NOT_FOUND → rethrow with code='TERMINAL_SESSION_NOT_FOUND' preserving cause.
 */
export async function readOutput(input: ReadOutputInput): Promise<ReadOutputOutput> {
  try {
    return await getSessionManager().readOutput(input);
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
// key 含会话 id、从不按会话清理 → 去重集合设容量上限:满了整体清空(极端规模下同 key 可能再告警一次,
// 换取内存不随历史会话数单调增长;正常规模下「同 key 只告警一次」语义不变)。
export const WARN_ONCE_MAX_KEYS = 1024;
const _warnedKeys = new Set<string>();
export function warnOnce(key: string, msg: string): void {
  if (_warnedKeys.has(key)) return;
  if (_warnedKeys.size >= WARN_ONCE_MAX_KEYS) _warnedKeys.clear();
  _warnedKeys.add(key);
  console.warn(`[terminal.service] ${msg}`);
}
/** 测试用:当前去重集合大小。 */
export function _warnedKeyCount(): number {
  return _warnedKeys.size;
}

// cleanupSessionLocal — idempotent local cleanup for Continuo-side state.
// Called sync BEFORE sm.kill (force/grace/window-close paths) because sm.kill
// disposes SessionManager onExit listener immediately (P0-1 fix from design review v3).
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

  // 1b. Flush any buffered output (also clears flushTimer).
  // The last chunk still sitting in the throttle window (often the command's final result / exit
  // banner) would otherwise be silently dropped. (审计 #1)
  flushPending(id, instance);
  // 1c. ring buffer 即将被 server-node 删除(自然退出 onExit 之后 / sm.kill 时)→ 先留快照。
  // 退出强杀(cleanupAll)时不留:进程随即退出、快照无人读取,每个 PTY 拼最多 4MB 只白占主线程与堆。
  if (!shuttingDown) retainExitedHistory(id);

  // 2. Clear all timers
  if (instance.killTimer) {
    clearTimeout(instance.killTimer);
    instance.killTimer = null;
  }

  // 3. Continuo-specific cleanup (shellCleanup is async — P1-1 fix)
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

  // 4. Remove from the map (finally-style — even if above threw)
  instances.delete(id);
  resizeChains.delete(id); // race(R17):清 resize 串行链,防 session 关闭后泄漏
}

interface Instance {
  /** 该会话输出 / 退出事件的投递目标(所属窗口)。 */
  readonly target: WebContents;
  pendingData: string;
  /** pendingData 首字符的累计偏移。 */
  pendingStart: number;
  /** 本会话累计收到的 PTY 输出字符数(UTF-16 code unit),历史回放与实时流衔接的坐标。 */
  receivedChars: number;
  flushTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  /** 当前 1s 吞吐窗口内累计 UTF-8 字节数(窗口起点 windowStart,惰性滚动)。 */
  bytesPerSecond: number;
  /** 当前吞吐窗口起点(ms,以创建时刻对齐,每格 THROTTLE_RESET_INTERVAL_MS)。 */
  windowStart: number;
  readonly mcpToken: string;
  readonly shellCleanup: () => Promise<void>;
}

const instances = new Map<string, Instance>();
// race(R17):per-session resize 串行链。连续 resize IPC 各自启动 SessionManager.resize() 不
// 串行,底层 Promise 可能乱序完成 —— 较早的小尺寸若晚于较新的大尺寸完成,会把 PTY 行列数回退
// 到旧值(UI 已按最新尺寸渲染但 PTY 停在旧 cols/rows → 换行/全屏 TUI/光标错乱)。经此链按调用
// 顺序串行应用,最新一次自然最后生效(last-wins,不回退)。
const resizeChains = new Map<string, Promise<unknown>>();

// ── 纯函数(可单测,export)─────────────────────────────────────

/**
 * 超出 maxBytes 时只保留尾部,前置 ANSI reset 防色码脏话。
 * 截断点若落在一个转义序列内部,就把截断点向后挪到该序列之后(见函数内说明)— 防 ANSI escape
 * 序列(如 `\x1b[31m`)被切成两半成乱码。
 */
// 边界(E244):前置的 ANSI reset(`\x1b[0m`)是 4 个 ASCII 字节。截断预算须先扣除它,否则返回值
// (reset + 尾部数据)真实字节数 = maxBytes + 4,违反"≤ maxBytes"契约(小上限/通用复用时明显超限)。
const RESET_PREFIX = '\x1b[0m';
const RESET_PREFIX_BYTES = 4;

/** 截断点向前找 ESC 的窗口(字符数)。覆盖常见的 SGR / 私有模式 / 窗口标题 OSC。 */
const ESCAPE_LOOKBACK_CHARS = 256;

/**
 * 从 `start`(一个 ESC 的下标)起的转义序列结束位置(最后一个字符之后的下标)。串尾未终结 → data.length。
 *  - CSI `ESC [`:参数字节 0x30–0x3F、中间字节 0x20–0x2F、终结符 0x40–0x7E(ECMA-48;含 `?`、`:`、空格等)。
 *  - OSC `ESC ]`:到 BEL 或 ST(`ESC \\`)。
 *  - 其它:中间字节 0x20–0x2F 若干 + 一个终结字节(`ESC ( B`、`ESC c` 等)。
 */
function escapeSequenceEnd(data: string, start: number): number {
  const len = data.length;
  const kind = data.charCodeAt(start + 1);
  if (Number.isNaN(kind)) return len;
  let j = start + 2;
  if (kind === 0x5b) {
    while (j < len && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x3f) j += 1;
    while (j < len && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x2f) j += 1;
    if (j >= len) return len;
    // 只消费合法的终结字节;畸形序列(被另一个 ESC、换行、非 ASCII 打断)到此为止,不吃后面的内容。
    const final = data.charCodeAt(j);
    return final >= 0x40 && final <= 0x7e ? j + 1 : j;
  }
  if (kind === 0x5d) {
    for (; j < len; j += 1) {
      const code = data.charCodeAt(j);
      if (code === 0x07) return j + 1;
      if (code === 0x1b && data.charCodeAt(j + 1) === 0x5c) return j + 2;
    }
    return len;
  }
  j = start + 1;
  while (j < len && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x2f) j += 1;
  if (j >= len) return len;
  const final = data.charCodeAt(j);
  return final >= 0x30 && final <= 0x7e ? j + 1 : j;
}

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

  // 转义序列边界:截断点若落在一个转义序列内部,保留的尾部会以序列残片开头(屏幕上多出 `25l` / `m` /
  // `]0;title` 之类的可见字符)。向前找最近的 ESC,若它的序列跨过截断点,就把截断点**向后**挪到该序列
  // 之后:跳过残片,且不多带字节(向前回退到 ESC 会突破 maxBytes 预算)。
  const searchStart = Math.max(0, cutPoint - ESCAPE_LOOKBACK_CHARS);
  for (let i = cutPoint - 1; i >= searchStart; i--) {
    if (data.charCodeAt(i) !== 0x1b) continue;
    const end = escapeSequenceEnd(data, i);
    if (end > cutPoint) cutPoint = end;
    break;
  }

  return RESET_PREFIX + data.slice(cutPoint);
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
  if (shuttingDown) throw createRejectedQuittingError();
  if (instances.has(id)) {
    throw new Error(`Terminal id "${id}" already exists`);
  }

  // Windows env 键大小写不敏感:宿主 `Path` 与调用方 `PATH` 普通展开会两键并存,node-pty 按插入顺序写
  // 环境块,子进程取到宿主值、调用方覆盖失效 → mergeSpawnEnv 只留后者的键(非 Windows 即普通展开)。
  const baseEnv = mergeSpawnEnv(mergeSpawnEnv(process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    // 显式声明终端身份,让用户 .zshrc / .bashrc 能区分 Continuo 与 iTerm。
    // 不显式设的话以下变量会从启动 Continuo 的父进程继承(常见 iTerm),
    // 用户的 if [[ TERM_PROGRAM == iTerm.app || LC_TERMINAL == iTerm2 ]]
    // 会误判,加载 powerline 主题而 Continuo xterm.js 调色板对不上 → light
    // 模式下 segment 黑底黑字。两个都得覆盖,||  任一命中就误判。
    TERM_PROGRAM: 'Continuo',
    LC_TERMINAL: 'Continuo',
  }), env ?? {});
  const baseEnvWithLang = withPtyLangEnv(
    baseEnv as Record<string, string | undefined>,
    getCurrentLocale(),
  );
  // bash / fish 不调用 helper(其 env 污染子进程,见 skipsShellIntegration);zsh 在 helper 内本就
  // 是 no-op。代价:bash / fish 暂无 OSC7 cwd 跟踪。准备失败(写脚本时磁盘满 / 权限 / ENOENT)直接上抛:
  // 此刻尚未分配本层资源,已签发的 mcpToken 由签发它的 ipc 层吊销。
  const { env: shellEnv, cleanup: shellCleanup } = skipsShellIntegration(shell)
    ? { env: baseEnvWithLang, cleanup: async () => {} }
    : await prepareShellIntegrationEnv(shell, baseEnvWithLang);
  // 退出闸:shell integration 准备是异步边界,期间 cleanupAll 可能已开始 → spawn 前复查。
  if (shuttingDown) {
    void shellCleanup().catch(() => {
      // ignore rollback cleanup errors
    });
    throw createRejectedQuittingError();
  }
  const envWithHookEvents = mergeSpawnEnv(shellEnv, {
    CONTINUO_HOOK_EVENTS_DIR: hookEventsDirFor(app.getPath('userData')),
    // 正确性(会话绑定):managed Stop hook 把它写进事件文件名,broker 据此只把 Stop 事件交给本会话的
    // await_stop_hook 等待者(不按 cwd 串给同窗口他会话)。放在 shellEnv 之后,用户 env 不能覆盖。
    // 非安全边界:会话内进程可改写该变量或直接读写 hook-events 目录,这里只防事件串会话。
    [TERMINAL_SESSION_ENV]: id,
  });
  // 强制 login + interactive shell:对齐 iTerm 默认行为 (`exec -l zsh`)。
  // 没 -l/-i 时 zsh 偶发不启 ZLE → zsh-autosuggestions 等 widget plugin 失效。
  // 用户传 args 优先,只在用户没传时加默认 flag。
  // 跨平台:`-l -i` 是 POSIX 交互 shell 语义,Windows powershell/cmd 不识别会启动失败,
  // /bin/sh(dash)/ 未知 shell 也未必支持 → defaultShellArgs 仅对 zsh/bash/fish 追加。
  // 刻意不采用 helper 返回的 bash args(['--rcfile', <rc>, '-i']):那是非 login 启动,不读
  // /etc/profile(macOS path_helper 在此),且 rcfile 无条件依次 source .bash_profile/.profile/
  // .bashrc → 重复执行、偏离 `-l -i` 语义(且 bash 现已整体不调用 helper,见上)。待兄弟仓库 helper
  // 仿 VSCode shellIntegration-bash 模拟 login 启动文件选择后再启用(doc/follow-ups.md)。
  const finalArgs = args.length === 0 ? defaultShellArgs(shell) : args;
  const inst: Instance = {
    target: win.webContents,
    pendingData: '',
    pendingStart: 0,
    receivedChars: 0,
    flushTimer: null,
    killTimer: null,
    bytesPerSecond: 0,
    windowStart: monotonicNow(),
    mcpToken: meta?.mcpToken ?? '',
    shellCleanup,
  };

  // PHASE 1: register all Continuo-side state BEFORE PTY spawn.
  instances.set(id, inst);

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
    try {
      void inst.shellCleanup().catch(() => {
        // ignore rollback cleanup errors
      });
    } catch {
      // ignore rollback cleanup errors
    }
    throw err;
  }
  // 退出闸:spawn 在途时 cleanupAll 开始 —— 它对尚未建立的 session 发的 SIGKILL 落空,本地状态也已拆除;
  // PTY 此刻才真正建立,不强杀即成孤儿。cleanupSessionLocal 幂等(已被拆除则 no-op)。
  if (shuttingDown) {
    cleanupSessionLocal(id, -1);
    await getSessionManager()
      .kill({ session_id: id, signal: 'SIGKILL' })
      .catch(() => undefined); // 进程正在退出,忽略 kill race。
    throw createRejectedQuittingError();
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
  // 串行 + 排空回收走共享 runSerialPerKey(任务自身吞错返回 false,链不会被 reject 打断)。
  return runSerialPerKey(resizeChains, id, () =>
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
}

// race(R12,R4 同族):await Ctrl-C 写入并上抛真实结果。此前 fire-and-forget 恒「成功」→ IPC
// 在实际中断前返回成功,PTY 检查后退出 / 写入失败时中断静默丢失,用户/agent 以为已中断但
// 进程可能继续跑。返回 false 让调用方(MCP terminal.kill 的 SIGINT 分支)上抛,不回报假成功。
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

  // Step 2: 3s grace, then SYNC cleanup + sm.kill (P0-1 fix from design review v3).
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
 * 先同步做本地清理(cleanupSessionLocal,exitCode 记 -1)再发 SIGKILL:sm.kill 会卸掉 exit 监听,
 * 等不到 PTY 的自然 onExit。
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
 * 开始即置退出闸,结束前再扫一遍登记表,强杀清理期间漏网登记的 PTY。
 */
export async function cleanupAll(): Promise<void> {
  shuttingDown = true;
  await forceKillAllRegistered();
  await forceKillAllRegistered();
}

async function forceKillAllRegistered(): Promise<void> {
  if (instances.size === 0) return; // 没开过终端就别 lazy-init SessionManager
  const sm = getSessionManager();
  const kills = new Array<Promise<void>>(instances.size);
  let killCount = 0;
  for (const id of instances.keys()) {
    const inst = instances.get(id);
    if (inst?.killTimer) {
      clearTimeout(inst.killTimer);
      inst.killTimer = null;
    }
    // 同步本地拆除(timers / listeners / mcp token revoke),exitCode -1。
    cleanupSessionLocal(id, -1);
    kills[killCount++] =
      sm.kill({ session_id: id, signal: 'SIGKILL' }).then(
        () => undefined,
        () => undefined, // 进程正在退出,忽略 kill race。
      );
  }
  kills.length = killCount;
  await Promise.all(kills);
}
