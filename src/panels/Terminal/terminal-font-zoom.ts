// 终端字体缩放(VSCode workbench.action.terminal.fontZoomIn / fontZoomOut / fontZoomReset 与 terminal.integrated.mouseWheelZoom):
// 对齐 VSCode src/vs/workbench/contrib/terminalContrib/zoom/browser/terminal.zoom.contribution.ts —— 终端没有独立的缩放级别,直接改设置
// terminal.integrated.fontSize(±1,夹取;重置 = 默认值),所有终端随设置生效、重启保持。无默认键。
// 刻意差异:夹取范围用本项目该设置的 [min, max](10..24,设置页同一范围),VSCode 为 6..100。BDD: src/__tests__/font-zoom/

import { useEffect, type RefObject } from 'react';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { getStoredSettingValue, useSettingsValuesStore, useSettingValue } from '@/plugins/settings/values-store';
import { TERMINAL_FONT_SIZE, TERMINAL_MOUSE_WHEEL_ZOOM } from '@/plugins/settings/core-setting-specs';
import { attachMouseWheelZoom } from '@/lib/mouse-wheel-zoom';

function clampTerminalFontSize(size: number): number {
  return Math.max(TERMINAL_FONT_SIZE.min!, Math.min(TERMINAL_FONT_SIZE.max!, size));
}

/** 终端字号 ±delta(写设置;已在边界不动)。 */
export function stepTerminalFontSize(delta: number): void {
  const stored = getStoredSettingValue(TERMINAL_FONT_SIZE.id);
  const current = typeof stored === 'number' && Number.isFinite(stored) ? clampTerminalFontSize(stored) : TERMINAL_FONT_SIZE.default;
  const next = clampTerminalFontSize(Math.round(current + delta));
  if (next === current) return;
  useSettingsValuesStore.getState().setValue(TERMINAL_FONT_SIZE.id, next);
}

/** 重置终端字号(删掉设置覆盖 = 默认值,同设置页「恢复默认」)。 */
export function resetTerminalFontSize(): void {
  useSettingsValuesStore.getState().reset(TERMINAL_FONT_SIZE.id);
}

/** terminal.integrated.mouseWheelZoom 打开时,在终端容器上按住 ⌘ / Ctrl 滚轮改字号(±1)。 */
export function useTerminalMouseWheelZoom(ref: RefObject<HTMLElement | null>): void {
  const enabled = useSettingValue(TERMINAL_MOUSE_WHEEL_ZOOM.id, TERMINAL_MOUSE_WHEEL_ZOOM.default);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    return attachMouseWheelZoom(el, stepTerminalFontSize);
  }, [enabled, ref]);
}

/** 命令 spec(TerminalPlugin 注册;分类「终端」,无默认键)。 */
export function terminalFontZoomCommandSpecs(): CommandSpec[] {
  return [
    {
      id: 'workbench.action.terminal.fontZoomIn',
      title: 'Increase Font Size',
      titleKey: 'commands.terminal.font_zoom_in.title',
      fn: () => stepTerminalFontSize(1),
    },
    {
      id: 'workbench.action.terminal.fontZoomOut',
      title: 'Decrease Font Size',
      titleKey: 'commands.terminal.font_zoom_out.title',
      fn: () => stepTerminalFontSize(-1),
    },
    {
      id: 'workbench.action.terminal.fontZoomReset',
      title: 'Reset Font Size',
      titleKey: 'commands.terminal.font_zoom_reset.title',
      fn: resetTerminalFontSize,
    },
  ].map((c) => ({ ...c, category: 'Terminal', categoryKey: 'commands.terminal.category' }));
}
