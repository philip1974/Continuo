// 窗口缩放级别(设置项 window.zoomLevel)的主进程内存态、持久化与套用。
// 对齐 VSCode `window.zoomLevel`(window.zoomPerWindow=false 时的语义):一个级别作用于所有窗口(主窗 + popout 子窗),
// 新窗口 / 重启后沿用。renderer 设置值是权威,经 window:set-zoom-level 推给 main;main 缓存到 userData/window-zoom.json,
// 冷启动在任何 renderer 上报前就能给首窗套用(同 window-theme.service 的「上次值」缓存,缺失 / 损坏 / 超大 → 0,不抛)。
// Chromium 自己按页面 URL 记缩放(per_host_zoom_levels,键含 ?windowSeq=N,只有 seq 0 主窗重启后命中)——每次主框架导航 /
// 加载完成都由 applyZoomToContents 用统一级别覆盖它,两者不再分叉。BDD: src/__tests__/window-zoom/
import path from 'node:path';
import { app, BrowserWindow, type WebContents } from 'electron';
import { z } from 'zod';
import { atomicWriteJson } from '../lib/atomic-write';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { createSerialQueue } from '../../shared/run-serial-per-key';
import { clampZoomLevel, DEFAULT_ZOOM_LEVEL } from '../../shared/window-zoom';

export const WINDOW_ZOOM_FILE_NAME = 'window-zoom.json';
const MAX_FILE_BYTES = 4 * 1024;

const WindowZoomSchema = z.object({ zoomLevel: z.number().finite() });

let level = DEFAULT_ZOOM_LEVEL;
// 已落盘的级别,相同则跳过写盘。
let persisted: number | null = null;
const writeQueue = createSerialQueue();

const zoomFile = (): string => path.join(app.getPath('userData'), WINDOW_ZOOM_FILE_NAME);

export function getWindowZoomLevel(): number {
  return level;
}

/** 启动时(创建首个窗口前)读取上次级别。永不抛。 */
export async function loadWindowZoom(): Promise<void> {
  try {
    const r = await readFileCappedFd(zoomFile(), MAX_FILE_BYTES);
    if (r.tooLarge) return;
    const parsed = WindowZoomSchema.safeParse(JSON.parse(r.text as string));
    if (!parsed.success) return;
    level = clampZoomLevel(parsed.data.zoomLevel);
    persisted = level;
  } catch {
    // 缺文件(首次启动)/ JSON 损坏 / 读失败:保持默认
  }
}

/** 把当前级别套到一个 webContents(已销毁 / 已相同 → 不动)。 */
export function applyZoomToContents(contents: WebContents): void {
  if (contents.isDestroyed() || contents.getZoomLevel() === level) return;
  contents.setZoomLevel(level);
}

/**
 * 每个窗口(主窗 + popout)建出时调用:主框架每次导航提交 / 加载完成都重新套用统一级别(含 reload),覆盖 Chromium 按 URL
 * 记下的旧级别。
 */
export function trackWindowZoom(contents: WebContents): void {
  const apply = (): void => applyZoomToContents(contents);
  contents.on('did-navigate', apply);
  contents.on('did-finish-load', apply);
}

/** renderer 推送设置值:夹取后更新内存态、立即套用到所有已开窗口,并串行持久化(失败只告警)。 */
export function setWindowZoomLevel(next: number): void {
  level = clampZoomLevel(next);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) applyZoomToContents(win.webContents);
  }
  void writeQueue
    .run(async () => {
      // 写入执行时的最新值:连续推送只落最后一次,不乱序覆盖
      const current = level;
      if (current === persisted) return;
      await atomicWriteJson(zoomFile(), { zoomLevel: current });
      persisted = current;
    })
    .catch((err: unknown) => console.warn('[window-zoom] persist failed', err));
}

/** Test helper:等待在途写盘完成。 */
export function flushWindowZoomForTest(): Promise<void> {
  return writeQueue.run(async () => undefined);
}

/** Test helper:清内存态(模拟进程重启)。 */
export function _resetWindowZoomForTest(): void {
  level = DEFAULT_ZOOM_LEVEL;
  persisted = null;
  writeQueue.reset();
}
