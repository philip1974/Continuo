// 窗口缩放级别(VSCode window.zoomLevel)的取值范围与规整,main 与 renderer 共用。
// VSCode platform/window/electron-browser/window.ts:MIN_ZOOM_LEVEL = -8 / MAX_ZOOM_LEVEL = 8;
// 每级 = 20%(Electron:缩放系数 = 1.2 ^ level)。BDD: src/__tests__/window-zoom/

export const MIN_ZOOM_LEVEL = -8;
export const MAX_ZOOM_LEVEL = 8;
export const DEFAULT_ZOOM_LEVEL = 0;

/** 非有限值 → 默认 0;其余夹到 [-8, 8](VSCode applyZoom 同样夹取)。 */
export function clampZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM_LEVEL;
  return Math.min(Math.max(level, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL);
}

/** 放大 / 缩小 / 重置缩放命令 id(VSCode 同名;renderer 注册,应用菜单为命令项,终端带 ⌘ 时让出)。 */
export const WINDOW_ZOOM_COMMAND_IDS = ['workbench.action.zoomIn', 'workbench.action.zoomOut', 'workbench.action.zoomReset'] as const;
