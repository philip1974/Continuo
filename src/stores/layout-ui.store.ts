// 全局 UI layout 状态(VSCode 风固定 sidebar 显隐控制等)。
// 与 explorer.store / editor.store 分离 — 这层只管"shell 布局",不管业务态。

import { create } from 'zustand';

type LayoutUiState = {
  /** 左侧 Explorer Sidebar 是否显示(IconSidebar Explorer 按钮 toggle). */
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
};

export const useLayoutUiStore = create<LayoutUiState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
