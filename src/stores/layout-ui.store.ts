// 全局 UI layout 状态(VSCode 风固定 sidebar 显隐 + 宽度)。
// 与 explorer.store / editor.store 分离 — 这层只管 shell 布局,不管业务态。
// sidebarOpen / sidebarWidth 通过 explorer.json 持久化(layoutUi 字段,
// 向下兼容缺失场景,见 explorer-persist)。

import { create } from 'zustand';

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 500;
export const SIDEBAR_DEFAULT_WIDTH = 280;

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
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
}));
