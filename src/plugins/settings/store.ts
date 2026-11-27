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
  /**
   * 待交给页签搜索框的焦点(命令「打开键盘快捷方式」切到快捷键页后,焦点落到该页搜索框):页签挂载 / 收到请求时取走并清除,
   * 之后切走再切回不再抢焦点。
   */
  tabSearchFocusRequested: boolean;
  /**
   * 待填进设置面板搜索框的查询(VSCode ISettingsEditorOptions.query,如 `@id:a,b`):面板挂载 / 收到时取走、填入并聚焦搜索框。
   */
  pendingSearchQuery: string | null;
  setActiveTabId: (id: string) => void;
  /** 切到页签并请求把焦点交给它的搜索框。 */
  showTabWithSearchFocus: (id: string) => void;
  /** 取走焦点请求(返回是否有请求)。 */
  takeTabSearchFocus: () => boolean;
  /** 请求把查询交给设置面板搜索框(配合 openSettingsWithQuery 打开面板)。 */
  requestSearchQuery: (query: string) => void;
  /** 取走待填的查询(无则 null)。 */
  takeSearchQuery: () => string | null;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  activeTabId: null,
  tabSearchFocusRequested: false,
  pendingSearchQuery: null,
  setActiveTabId: (id) =>
    set((s) => (s.activeTabId === id ? s : { activeTabId: id })),
  showTabWithSearchFocus: (id) => set({ activeTabId: id, tabSearchFocusRequested: true }),
  takeTabSearchFocus: () => {
    if (!get().tabSearchFocusRequested) return false;
    set({ tabSearchFocusRequested: false });
    return true;
  },
  requestSearchQuery: (query) => set({ pendingSearchQuery: query }),
  takeSearchQuery: () => {
    const query = get().pendingSearchQuery;
    if (query !== null) set({ pendingSearchQuery: null });
    return query;
  },
}));
