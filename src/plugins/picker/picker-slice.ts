// 「搜索框 + 键盘选中列表」类弹层(CommandPalette / QuickOpen)共用的 store 切片(重构:两个 store
// 此前逐字复制 open / close / setQuery / moveSelection / clampSelection)。
//
// 所有 action 在无变化时返回原 state(不触发订阅者重渲染)。
//
// BDD: src/__tests__/picker-shared/

import { clampSearchQuery } from '@/lib/search-query';

export interface PickerSlice {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  /** 打开并重置 query / 选中行。 */
  open: () => void;
  /** 只关闭;query / 选中行保留(各 store 自己决定其余字段去留)。 */
  close: () => void;
  setQuery: (q: string) => void;
  /** 循环移动选中行(到底跳头,到头跳尾);max<=0 时归 0. */
  moveSelection: (delta: number, max: number) => void;
  /**
   * race(R48/R49):把 selectedIndex 钳到 [0, len-1](空列表置 0)。列表随 registry / 异步扫描 /
   * query 收窄动态变短时,旧 selectedIndex 可能越界 → Enter 读 filtered[idx]=undefined、高亮悬空。
   * 组件在列表长度变化时调用。
   */
  clampSelection: (len: number) => void;
}

type PickerSet = (
  updater: (s: PickerSlice) => PickerSlice | Partial<PickerSlice>,
) => void;

export function createPickerSlice(set: PickerSet): PickerSlice {
  return {
    isOpen: false,
    query: '',
    selectedIndex: 0,

    open: () =>
      set((s) =>
        s.isOpen && s.query === '' && s.selectedIndex === 0
          ? s
          : { isOpen: true, query: '', selectedIndex: 0 },
      ),
    close: () => set((s) => (s.isOpen ? { isOpen: false } : s)),
    // 边界(E279):截断超长 query(防单次 paste 触发 O(候选×queryLen) fuzzy 卡死 renderer)。
    setQuery: (q) =>
      set((s) => {
        const query = clampSearchQuery(q);
        return s.query === query && s.selectedIndex === 0
          ? s
          : { query, selectedIndex: 0 };
      }),
    moveSelection: (delta, max) =>
      set((s) => {
        if (max <= 0) return s.selectedIndex === 0 ? s : { selectedIndex: 0 };
        const next = (s.selectedIndex + delta + max) % max;
        return next === s.selectedIndex ? s : { selectedIndex: next };
      }),
    clampSelection: (len) =>
      set((s) => {
        const clamped = len <= 0 ? 0 : Math.min(s.selectedIndex, len - 1);
        return clamped === s.selectedIndex ? s : { selectedIndex: clamped };
      }),
  };
}
