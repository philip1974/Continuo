// Quick Open 状态(VSCode ⌘P 同款)。Zustand vanilla。
//
// 与 CommandPalette store 区别:
// - 加 results: 文件列表(walk 异步加载,close 后保留供下次 reopen)
// - 加 loading: walk 期间 spinner

import { create } from 'zustand';
import { clampSearchQuery } from '@/lib/search-query';

export interface QuickOpenFile {
  /** 绝对路径(用于 openFileByPath). */
  readonly absPath: string;
  /** 相对 rootPath 的展示路径(列表灰色辅助文字). */
  readonly relPath: string;
  /**
   * 性能 P16:relPath.toLowerCase() 预计算(scan 时一次)。fuzzyFilter 用它做大小写
   * 不敏感匹配,避免每按键对全部候选重复 lowercasing。relPath 在一次 scan 内稳定。
   */
  readonly relPathLower: string;
  /** basename(列表主标题). */
  readonly name: string;
}

interface QuickOpenState {
  isOpen: boolean;
  query: string;
  selectedIndex: number;
  results: readonly QuickOpenFile[];
  /**
   * race(R2):results 归属的 workspace root。切 workspace 后重开 Quick Open,旧 root 的
   * results 仍在 store(秒级再开复用优化),若不绑定 root 会在新 root 扫描期间展示并允许打开
   * 旧 workspace 文件(跨 root 泄漏)。setResults 记录 root,渲染只信任 resultsRoot === 当前 root。
   */
  resultsRoot: string | null;
  loading: boolean;
  /** walk 失败标志 —— 与"workspace 真为空"区分,避免静默失败伪装成空列表。 */
  scanFailed: boolean;
  open: () => void;
  close: () => void;
  setQuery: (q: string) => void;
  moveSelection: (delta: number, max: number) => void;
  /**
   * race(R48):把 selectedIndex 钳到 [0, len-1](空列表置 0)。后台 scan 完成 setResults 替换
   * 列表 / query 改变使过滤结果变短时,旧 selectedIndex 可能越界 → Enter 读 filtered[idx]=undefined
   * 打开失效、高亮/滚动停无效项。组件在 filtered.length 变化时调用。已在范围内则返回原 state,
   * 不触发 selectedIndex 订阅者重渲染。
   */
  clampSelection: (len: number) => void;
  setResults: (files: readonly QuickOpenFile[], root?: string | null) => void;
  setLoading: (b: boolean) => void;
  setScanFailed: (b: boolean) => void;
}

function quickOpenResultsEqual(
  a: readonly QuickOpenFile[],
  b: readonly QuickOpenFile[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.absPath !== right.absPath ||
      left.relPath !== right.relPath ||
      left.relPathLower !== right.relPathLower ||
      left.name !== right.name
    ) {
      return false;
    }
  }
  return true;
}

export const useQuickOpenStore = create<QuickOpenState>((set) => ({
  isOpen: false,
  query: '',
  selectedIndex: 0,
  results: [],
  resultsRoot: null,
  loading: false,
  scanFailed: false,

  open: () =>
    set((s) =>
      s.isOpen && s.query === '' && s.selectedIndex === 0
        ? s
        : { isOpen: true, query: '', selectedIndex: 0 },
    ),
  // 不清 results / query — 用户秒级再开还能看到上次的列表。
  // 真要 reset 在 walk 完成后才 setResults。
  close: () => set((s) => (s.isOpen ? { isOpen: false } : s)),
  // 边界(E279):截断超长 query(防单次 paste 触发 O(results×queryLen) fuzzyFilter 卡死 renderer)。
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
  // root 省略(单参旧调用)→ resultsRoot 置 null;组件扫描时显式传当前 root 绑定归属。
  setResults: (files, root = null) =>
    set((s) =>
      s.resultsRoot === root && quickOpenResultsEqual(s.results, files)
        ? s
        : { results: files, resultsRoot: root },
    ),
  setLoading: (b) => set((s) => (s.loading === b ? s : { loading: b })),
  setScanFailed: (b) =>
    set((s) => (s.scanFailed === b ? s : { scanFailed: b })),
}));
