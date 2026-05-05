// PTY service(M-Terminal Step T1,从 MindAutonAgent 移植)。
// node-pty 实例 map<id, Instance>;输出节流 / 截断 / overflow 通知;
// kill grace period 3s 优雅终止。

import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import * as terminalSessions from './terminal-sessions.service';

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

export function createTerminal(
  id: string,
  win: BrowserWindow,
  shell: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): void {
  const p = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...env,
    } as Record<string, string>,
  });

  const inst: Instance = {
    pty: p,
    pendingData: '',
    flushTimer: null,
    killTimer: null,
    bytesPerSecond: 0,
    throttleInterval: null,
    overflowNotified: false,
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

  p.onData((data) => {
    inst.bytesPerSecond += data.length;

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

function cleanup(id: string): void {
  const inst = instances.get(id);
  if (!inst) return;
  if (inst.throttleInterval) clearInterval(inst.throttleInterval);
  if (inst.flushTimer) clearTimeout(inst.flushTimer);
  if (inst.killTimer) clearTimeout(inst.killTimer);
  instances.delete(id);
}

/** 主进程退出前调,kill 所有 PTY 防 zombie. */
export function cleanupAll(): void {
  const ids = Array.from(instances.keys());
  for (const id of ids) {
    kill(id);
  }
}
