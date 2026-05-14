// PTY service(M-Terminal Step T1,从 MindAutonAgent 移植)。
// node-pty 实例 map<id, Instance>;输出节流 / 截断 / overflow 通知;
// kill grace period 3s 优雅终止。

import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import * as terminalSessions from './terminal-sessions.service';
import * as terminalBuffer from './terminal-buffer.service';
import { mcpRevokers } from './mcp-host.service';
import { prepareEnv } from './shell-integration';

// ── 常量(节流参数,沿用 Mind 决策 #5)──────────────────────────
const OVERFLOW_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MB/s 触发 overflow
const TRUNCATE_MAX_BYTES = 64 * 1024;             // overflow 时单 chunk 上限
const FLUSH_DELAY_OVERFLOW_MS = 100;
const FLUSH_DELAY_INPLACE_MS = 64;
const FLUSH_DELAY_DEFAULT_MS = 32;
const THROTTLE_RESET_INTERVAL_MS = 1_000;
const KILL_GRACE_PERIOD_MS = 3_000;

interface Instance {
  pty: pty.IPty;
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
  const { env: shellEnv, cleanup: shellCleanup } = await prepareEnv(
    shell,
    baseEnv,
  );
  // 强制 login + interactive shell:对齐 iTerm 默认行为 (`exec -l zsh`)。
  // 没 -l/-i 时 zsh 偶发不启 ZLE → zsh-autosuggestions 等 widget plugin 失效。
  // 用户传 args 优先,只在用户没传时加默认 flag。
  const finalArgs = args.length === 0 ? ['-l', '-i'] : args;
  const p = pty.spawn(shell, finalArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: shellEnv as Record<string, string>,
  });

  const inst: Instance = {
    pty: p,
    pendingData: '',
    flushTimer: null,
    killTimer: null,
    bytesPerSecond: 0,
    throttleInterval: null,
    overflowNotified: false,
    mcpToken: meta?.mcpToken ?? '',
    shellCleanup,
  };

  const send = (data: string) => {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:data', id, data);
    }
  };

  const flush = () => {
    if (inst.pendingData) {
      send(inst.pendingData);
      inst.pendingData = '';
    }
    inst.flushTimer = null;
  };

  // 创建 buffer(P3:agent read_output 用),onData 内写入完整 raw data,
  // 渲染节流由下面 inst.pendingData 单独处理。
  terminalBuffer.ensure(id);

  p.onData((data) => {
    inst.bytesPerSecond += data.length;
    // 入 buffer:agent 看完整流(限于 buffer 容量),与 xterm 节流解耦
    terminalBuffer.append(id, data);

    const isOverflow = inst.bytesPerSecond > OVERFLOW_THRESHOLD_BYTES;
    if (isOverflow) {
      inst.pendingData = safeTruncate(
        inst.pendingData + data,
        TRUNCATE_MAX_BYTES,
      );
      if (!inst.overflowNotified) {
        inst.overflowNotified = true;
        if (!win.isDestroyed()) {
          win.webContents.send('terminal:overflow', id);
        }
      }
      if (!inst.flushTimer) {
        inst.flushTimer = setTimeout(flush, FLUSH_DELAY_OVERFLOW_MS);
      }
      return;
    }

    if (inst.overflowNotified) {
      inst.overflowNotified = false;
      if (!win.isDestroyed()) {
        win.webContents.send('terminal:overflow-recovered', id);
      }
    }
    inst.pendingData += data;

    if (!inst.flushTimer) {
      const delay = isInPlaceUpdate(data)
        ? FLUSH_DELAY_INPLACE_MS
        : FLUSH_DELAY_DEFAULT_MS;
      inst.flushTimer = setTimeout(flush, delay);
    }
  });

  p.onExit(({ exitCode, signal }) => {
    flush();
    // 标记 session metadata exitCode → 推 sessions_changed → renderer 显 closed。
    // 若 metadata 已被 remove 删掉(用户主动关 X),setExited 内部 no-op。
    terminalSessions.setExited(id, exitCode ?? -1);
    cleanup(id);
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:exit', id, { exitCode, signal });
    }
  });

  instances.set(id, inst);
  inst.throttleInterval = setInterval(() => {
    inst.bytesPerSecond = 0;
  }, THROTTLE_RESET_INTERVAL_MS);
}

export function has(id: string): boolean {
  return instances.has(id);
}

export function write(id: string, data: string): boolean {
  const inst = instances.get(id);
  if (!inst) return false;
  try {
    inst.pty.write(data);
    return true;
  } catch (err) {
    console.warn('[terminal.service] pty write failed', id, err);
    return false;
  }
}

export function resize(id: string, cols: number, rows: number): boolean {
  const inst = instances.get(id);
  if (!inst) return false;
  try {
    inst.pty.resize(cols, rows);
    return true;
  } catch (err) {
    console.warn('[terminal.service] pty resize failed', id, err);
    return false;
  }
}

export function interrupt(id: string): void {
  instances.get(id)?.pty.write('\x03');
}

/**
 * 优雅终止:先发 Ctrl+C,3s 后 force kill。
 * 重复调 kill 同 id 不会重复设 timer。
 */
export function kill(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.killTimer) return;
  inst.pty.write('\x03');
  inst.killTimer = setTimeout(() => {
    inst.killTimer = null;
    if (!instances.has(id)) return;
    try {
      inst.pty.kill();
    } catch (err) {
      console.warn('[terminal.service] pty kill failed', id, err);
    }
    cleanup(id);
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
  try {
    inst.pty.kill('SIGKILL');
  } catch (err) {
    console.warn('[terminal.service] pty SIGKILL failed', id, err);
  }
}

function cleanup(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.throttleInterval) clearInterval(inst.throttleInterval);
  if (inst.flushTimer) clearTimeout(inst.flushTimer);
  if (inst.killTimer) clearTimeout(inst.killTimer);
  if (inst.mcpToken) mcpRevokers().byToken(inst.mcpToken);
  void inst.shellCleanup().catch((err) => {
    console.warn('[terminal.service] shell integration cleanup failed', id, err);
  });
  instances.delete(id);
}

/** 主进程退出前调,kill 所有 PTY 防 zombie. */
export function cleanupAll(): void {
  const ids = Array.from(instances.keys());
  for (const id of ids) {
    kill(id);
  }
}
