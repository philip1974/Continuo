// 按住缩放修饰键滚动鼠标滚轮 → 字体缩放一级(编辑器 editor.mouseWheelZoom、终端 terminal.integrated.mouseWheelZoom 共用)。
// 修饰键判定 Ported from microsoft/vscode (MIT, © Microsoft Corporation; see LICENSE-3RD-PARTY.md):
// src/vs/workbench/contrib/terminalContrib/zoom/browser/terminal.zoom.contribution.ts `_hasMouseWheelZoomModifiers`
//(macOS:⌘ 或 ⌃ —— ⌃ 是触控板双指捏合 —— 且不带 ⇧ / ⌥;其它平台:只按 Ctrl)。
// 刻意差异:VSCode 用 MouseWheelClassifier 区分物理滚轮(每格 ±1)与触控板(按手势累计),这里不做分类:按行滚动或单次
// |deltaY| ≥ 一格(50px)的事件 = ±1 级,更小的像素增量(触控板 / 捏合)累计满一格再 ±1,停顿超过 200ms 重新累计。
// 捕获阶段监听并 preventDefault:不让编辑器 / xterm 同时滚动,也不触发 Chromium 自己的页面缩放。

import { detectPlatform, type Platform } from '@/plugins/command-palette/format-hotkey';

/** 累计满这么多像素算一级(Chromium 物理滚轮一格 deltaY 约 100)。 */
const WHEEL_ZOOM_STEP_PX = 50;
const GESTURE_GAP_MS = 200;

export function hasMouseWheelZoomModifiers(
  e: Pick<WheelEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  platform: Platform = detectPlatform(),
): boolean {
  if (e.shiftKey || e.altKey) return false;
  return platform === 'mac' ? e.metaKey || e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 挂到元素上;onZoom(+1 放大 / -1 缩小)。返回卸载函数。 */
export function attachMouseWheelZoom(
  el: HTMLElement,
  onZoom: (delta: 1 | -1) => void,
  platform: Platform = detectPlatform(),
): () => void {
  let acc = 0;
  let last = 0;
  const onWheel = (e: WheelEvent): void => {
    if (!hasMouseWheelZoomModifiers(e, platform) || e.deltaY === 0) return;
    e.preventDefault();
    e.stopPropagation();
    // 向上滚(deltaY < 0)放大,同 VSCode
    const dir: 1 | -1 = e.deltaY < 0 ? 1 : -1;
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= WHEEL_ZOOM_STEP_PX) {
      acc = 0;
      onZoom(dir);
      return;
    }
    const now = e.timeStamp;
    if (now - last > GESTURE_GAP_MS || Math.sign(acc) === Math.sign(e.deltaY) * -1) acc = 0;
    last = now;
    acc += e.deltaY;
    while (Math.abs(acc) >= WHEEL_ZOOM_STEP_PX) {
      acc -= Math.sign(acc) * WHEEL_ZOOM_STEP_PX;
      onZoom(dir);
    }
  };
  el.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => el.removeEventListener('wheel', onWheel, { capture: true });
}
