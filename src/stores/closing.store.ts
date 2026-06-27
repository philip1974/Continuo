import { create } from 'zustand';

// dockview 没有 onWillRemovePanel,无法让 dockview 等动画完再卸载;
// 折中:把"用户已请求关闭、但还没真正调 api.close"的 panel id 放这,
// PanelMount 据此切到 EXIT 动画,SharedTab 的 setTimeout 才真 close。
type ClosingState = {
  ids: ReadonlySet<string>;
  mark: (id: string) => void;
  unmark: (id: string) => void;
};

const EMPTY_CLOSING_IDS: ReadonlySet<string> = new Set();

export const useClosingStore = create<ClosingState>((set) => ({
  ids: EMPTY_CLOSING_IDS,
  mark: (id) =>
    set((s) => {
      if (s.ids.has(id)) return s;
      const next = new Set(s.ids);
      next.add(id);
      return { ids: next };
    }),
  unmark: (id) =>
    set((s) => {
      if (!s.ids.has(id)) return s;
      if (s.ids.size === 1) return { ids: EMPTY_CLOSING_IDS };
      const next = new Set(s.ids);
      next.delete(id);
      return { ids: next };
    }),
}));
