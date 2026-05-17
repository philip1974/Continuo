// 启动/刷新黑屏诊断 breadcrumb。
//
// 写入 `<userData>/logs/reload-breadcrumb.log`,JSONL append-only。
// 容忍写失败 — 诊断辅助绝不能挂主流程。
//
// 行为契约见 `src/__tests__/splash-watchdog/README.md` 同主题侧。
// (此模块本身是观测设施,无 BDD,但消费它的 watchdog 有。)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let _logFile: string | null = null;
let _initFailed = false;

function getLogFile(): string | null {
  if (_initFailed) return null;
  if (_logFile) return _logFile;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    _logFile = path.join(dir, 'reload-breadcrumb.log');
    return _logFile;
  } catch {
    _initFailed = true;
    return null;
  }
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export interface BreadcrumbEntry {
  readonly event: string;
  readonly [k: string]: unknown;
}

/**
 * Append a JSONL breadcrumb line. Adds `t` (epoch ms) and `pid` automatically.
 * 失败静默(console.warn 一次,不抛)。
 */
export async function appendBreadcrumb(entry: BreadcrumbEntry): Promise<void> {
  const file = getLogFile();
  if (!file) return;
  const line =
    JSON.stringify({ t: Date.now(), pid: process.pid, ...entry }) + '\n';
  try {
    await ensureDir(file);
    await fs.appendFile(file, line, 'utf8');
  } catch (err) {
    if (!_initFailed) {
      console.warn('[breadcrumb] append failed (suppressing further):', err);
      _initFailed = true;
    }
  }
}

/** Fire-and-forget 包装。生产代码用 `void breadcrumb({...})`. */
export function breadcrumb(entry: BreadcrumbEntry): void {
  void appendBreadcrumb(entry);
}

/** 返回日志目录(给"打开日志目录"按钮用). */
export function getLogsDir(): string | null {
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch {
    return null;
  }
}

/** Test helper: 重置状态. */
export function _resetForTest(): void {
  _logFile = null;
  _initFailed = false;
}

/**
 * 包装一段异步逻辑,耗时 > thresholdMs 或抛错时写一条 `ipc_slow` breadcrumb。
 * IPC handler 用于排查"explorer:read / layout:read 是否在某些情况下 hang"。
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
  thresholdMs = 500,
): Promise<T> {
  const start = Date.now();
  let ok = true;
  let errMsg: string | undefined;
  try {
    return await fn();
  } catch (err) {
    ok = false;
    errMsg = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const dur = Date.now() - start;
    if (!ok || dur > thresholdMs) {
      breadcrumb({
        event: 'ipc_slow',
        label,
        durationMs: dur,
        ok,
        ...(errMsg ? { errMsg } : {}),
      });
    }
  }
}
