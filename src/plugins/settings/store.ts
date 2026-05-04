// Settings Modal 状态(M-Plugin v2.4)。
// isOpen + activeTabId,与 commandPalette 同模式。

import { create } from 'zustand';

interface SettingsState {
  isOpen: boolean;
  activeTabId: string | null;
  open: (tabId?: string) => void;
  close: () => void;
  setActiveTabId: (id: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  activeTabId: null,
  open: (tabId) => set({ isOpen: true, activeTabId: tabId ?? null }),
  close: () => set({ isOpen: false }),
  setActiveTabId: (id) => set({ activeTabId: id }),
}));
