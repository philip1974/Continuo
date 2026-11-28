// 编辑器字体缩放(VSCode editor.action.fontZoomIn / fontZoomOut / fontZoomReset 与 editor.mouseWheelZoom):
// Ported from microsoft/vscode (MIT, © Microsoft Corporation; see LICENSE-3RD-PARTY.md):
//   src/vs/editor/common/config/editorZoom.ts —— 全局临时缩放级别(内存态,夹在 [-5, 20],不写设置、重启归零);
//   src/vs/editor/common/config/fontInfo.ts —— 字号 / 行高 × (1 + 级别 × 0.1);
//   src/vs/editor/contrib/fontZoom/browser/fontZoom.ts —— 放大 / 缩小 = 级别 ±1,重置 = 0(无默认键)。
// 作用于所有编辑器(代码编辑器、Markdown 源码 / 编辑模式、冲突比较;主窗与 popout 子窗 —— 子窗面板同在主窗 JS 环境渲染),
// 不改 editor.fontSize 设置。滚轮缩放:editor.mouseWheelZoom 打开后按住 ⌘(Windows / Linux Ctrl)滚轮 = ±1 级(见 mouse-wheel-zoom)。
// BDD: src/__tests__/font-zoom/

import { useEffect, type CSSProperties, type RefObject } from 'react';
import { create } from 'zustand';
import type { CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  EDITOR_FONT_SIZE,
  EDITOR_LINE_HEIGHT,
  EDITOR_MOUSE_WHEEL_ZOOM,
} from '@/plugins/settings/core-setting-specs';
import { resolveEditorLineHeightPx } from '@/plugins/settings/font-settings';
import { EDITOR_LINE_HEIGHT_VAR } from '@/plugins/settings/EditorFontFromSettings';
import { attachMouseWheelZoom } from '@/lib/mouse-wheel-zoom';

export const MIN_EDITOR_ZOOM_LEVEL = -5;
export const MAX_EDITOR_ZOOM_LEVEL = 20;

const useEditorZoomStore = create<{ readonly level: number }>(() => ({ level: 0 }));

export function getEditorZoomLevel(): number {
  return useEditorZoomStore.getState().level;
}

/** 设缩放级别(夹到 [-5, 20];VSCode EditorZoom.setZoomLevel)。 */
export function setEditorZoomLevel(level: number): void {
  const next = Math.min(Math.max(MIN_EDITOR_ZOOM_LEVEL, level), MAX_EDITOR_ZOOM_LEVEL);
  if (!Number.isFinite(next) || next === getEditorZoomLevel()) return;
  useEditorZoomStore.setState({ level: next });
}

/** 缩放级别对应的倍率(VSCode BareFontInfo:1 + level × 0.1)。 */
export function editorZoomMultiplier(level: number): number {
  return 1 + level * 0.1;
}

/** 缩放后的字号(保留两位小数,避免 13 × 1.1 这类浮点尾巴进 CSS)。 */
export function zoomedEditorFontSize(fontSize: number, level: number): number {
  return Math.round(fontSize * editorZoomMultiplier(level) * 100) / 100;
}

/** 当前生效的编辑器字号(设置 editor.fontSize × 缩放倍率)。 */
export function useEditorFontSize(): number {
  const fontSize = useSettingValue(EDITOR_FONT_SIZE.id, EDITOR_FONT_SIZE.default);
  const level = useEditorZoomStore((s) => s.level);
  return zoomedEditorFontSize(fontSize, level);
}

/**
 * 编辑器容器的字号样式:字号 × 倍率;设置了行高(非自动)时行高同样 × 倍率(VSCode fontInfo 同时放大 lineHeight),写到容器上
 * 覆盖 <html> 上的未缩放值(EditorFontFromSettings)。自动行高按字号相对计算,随字号一起缩放。
 */
export function useEditorFontStyle(): CSSProperties {
  const fontSize = useSettingValue(EDITOR_FONT_SIZE.id, EDITOR_FONT_SIZE.default);
  const lineHeightSetting = useSettingValue(EDITOR_LINE_HEIGHT.id, EDITOR_LINE_HEIGHT.default);
  const level = useEditorZoomStore((s) => s.level);
  const style: Record<string, string> = { fontSize: `${zoomedEditorFontSize(fontSize, level)}px` };
  const lineHeight = resolveEditorLineHeightPx(lineHeightSetting, fontSize);
  if (level !== 0 && lineHeight !== null) {
    style[EDITOR_LINE_HEIGHT_VAR] = `${Math.round(lineHeight * editorZoomMultiplier(level))}px`;
  }
  return style as CSSProperties;
}

/** editor.mouseWheelZoom 打开时,在编辑器容器上按住 ⌘ / Ctrl 滚轮缩放(±1 级)。 */
export function useEditorMouseWheelZoom(ref: RefObject<HTMLElement | null>): void {
  const enabled = useSettingValue(EDITOR_MOUSE_WHEEL_ZOOM.id, EDITOR_MOUSE_WHEEL_ZOOM.default);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    return attachMouseWheelZoom(el, (delta) => setEditorZoomLevel(getEditorZoomLevel() + delta));
  }, [enabled, ref]);
}

/** 命令 spec(EditorPlugin 注册;VSCode 无默认键、无分类)。 */
export function editorFontZoomCommandSpecs(): CommandSpec[] {
  return [
    {
      id: 'editor.action.fontZoomIn',
      title: 'Increase Editor Font Size',
      titleKey: 'commands.editor.font_zoom_in.title',
      fn: () => setEditorZoomLevel(getEditorZoomLevel() + 1),
    },
    {
      id: 'editor.action.fontZoomOut',
      title: 'Decrease Editor Font Size',
      titleKey: 'commands.editor.font_zoom_out.title',
      fn: () => setEditorZoomLevel(getEditorZoomLevel() - 1),
    },
    {
      id: 'editor.action.fontZoomReset',
      title: 'Reset Editor Font Size',
      titleKey: 'commands.editor.font_zoom_reset.title',
      fn: () => setEditorZoomLevel(0),
    },
  ];
}
