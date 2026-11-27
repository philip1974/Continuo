// 全局 UI layout 状态(VSCode 风固定 sidebar 显隐 + 宽度)。
// 与 explorer.store / editor.store 分离 — 这层只管 shell 布局,不管业务态。
// sidebarOpen / sidebarWidth 通过 explorer.json 持久化(layoutUi 字段,
// 向下兼容缺失场景,见 explorer-persist)。

import { create } from 'zustand';

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 280;
/**
 * 编辑区(Dockview)最小宽度:窗口变窄时侧栏先让位,给编辑区至少留这么宽。取 VSCode 编辑区最小宽度
 * (workbench editor.ts DEFAULT_EDITOR_MIN_DIMENSIONS.width = 220)。
 */
export const EDITOR_MIN_WIDTH = 220;

/**
 * 侧栏在给定可用宽度(侧栏左边缘到窗口右边缘)下的有效上限:扣掉编辑区最小宽度 —— EDITOR_MIN_WIDTH 与 dock 网格实际
 * 最小宽度(dockMinWidth,dockview minimumWidth:多组并排时是各组最小宽之和)取大 —— 夹在 [MIN, MAX]。
 * 窗口窄到连侧栏最小宽都放不下时取 MIN(侧栏不再继续缩)。只约束显示与拖拽,不改保存的 sidebarWidth。
 */
export function sidebarMaxWidthFor(available: number, dockMinWidth = 0): number {
  return Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, available - Math.max(EDITOR_MIN_WIDTH, dockMinWidth)),
  );
}

/**
 * 侧栏缩到最小宽后 dock 网格是否仍放得下(available − SIDEBAR_MIN_WIDTH ≥ dockMinWidth)。放不下 → 侧栏收起
 *(同 VSCode 侧栏 snap:分隔条拖到放不下最小宽时整个收起),免得最右的组与其「⋯ / 弹出」按钮被裁到窗口外。
 * 只看 dock 实际最小宽(单组 100):单组窄窗口(如 400 宽)仍保留最小宽侧栏,与此前一致。
 */
export function sidebarFitsBesideDock(available: number, dockMinWidth: number): boolean {
  return available - SIDEBAR_MIN_WIDTH >= dockMinWidth;
}

type LayoutUiState = {
  /** 左侧 Explorer Sidebar 是否显示. */
  sidebarOpen: boolean;
  /** 左侧 Explorer Sidebar 宽度(px,clamp 在 [MIN, MAX] 之间). */
  sidebarWidth: number;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (px: number) => void;
};

export const useLayoutUiStore = create<LayoutUiState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) =>
    set((s) => (s.sidebarOpen === sidebarOpen ? s : { sidebarOpen })),
  setSidebarWidth: (sidebarWidth) =>
    set((s) => (s.sidebarWidth === sidebarWidth ? s : { sidebarWidth })),
}));
