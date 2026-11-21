// Settings Panel state(VSCode 同款)。
//
// v5 Phase 5:Settings 从 Modal 改为 dockview panel。store 退化为
// "当前激活 tab" 单字段 — panel 生命周期(open/close)由 dockview
// 负责,不再有 isOpen / open / close。
//
// activeTabId 在 panel unmount 后仍保留(决策 #2),让用户重开 panel
// 时回到上次选中的 tab。
//
// BDD: src/__tests__/settings-panel/

import { create } from 'zustand';

interface SettingsState {
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  activeTabId: null,
  setActiveTabId: (id) =>
    set((s) => (s.activeTabId === id ? s : { activeTabId: id })),
}));
