// Quick Open 状态(VSCode ⌘P 同款)。Zustand store(`zustand` 的 create)。
//
// 与 CommandPalette store 区别:
// - 加 results: 文件列表(walk 异步加载,close 后保留供下次 reopen)
// - 加 loading: walk 期间 spinner

import { create } from 'zustand';
import { createPickerSlice, type PickerSlice } from '../picker/picker-slice';
import { arraysEqual } from '@shared/array-equal';

/**
 * Quick Open 单次扫描的**候选**文件数上限:walk-files 到顶即截断,QuickOpenModal 据此显示「只搜索了前 N 个文件」提示
 *(有结果与无匹配时都显示)。VSCode 的 Quick Open 候选不截断(只截断结果数);这里保留一个足够大的兜底上限,与「在文件中
 * 查找」的枚举上限(SEARCH_MAX_FILES)同值 —— 此前 5000:2 万文件的工作区里根下文件、src/ 下文件全进不了候选(第二十四轮)。
 * 实测 2.1 万文件:main 侧 list-dir 约 75ms、IPC 约 4MB。
 */
export const QUICK_OPEN_MAX_FILES = 50_000;

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

// isOpen / query / selectedIndex 与 open / close / setQuery / moveSelection / clampSelection 来自
// 共享 picker 切片。close 不清 results / query —— 用户秒级再开还能看到上次的列表。
interface QuickOpenState extends PickerSlice {
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
  setResults: (files: readonly QuickOpenFile[], root: string | null) => void;
  setLoading: (b: boolean) => void;
  setScanFailed: (b: boolean) => void;
}

function quickOpenResultsEqual(
  a: readonly QuickOpenFile[],
  b: readonly QuickOpenFile[],
): boolean {
  return arraysEqual(
    a,
    b,
    (left, right) =>
      left.absPath === right.absPath &&
      left.relPath === right.relPath &&
      left.relPathLower === right.relPathLower &&
      left.name === right.name,
  );
}

export const useQuickOpenStore = create<QuickOpenState>((set) => ({
  ...createPickerSlice(set),
  results: [],
  resultsRoot: null,
  loading: false,
  scanFailed: false,

  // 组件扫描时显式传当前 root 绑定归属。
  setResults: (files, root) =>
    set((s) =>
      s.resultsRoot === root && quickOpenResultsEqual(s.results, files)
        ? s
        : { results: files, resultsRoot: root },
    ),
  setLoading: (b) => set((s) => (s.loading === b ? s : { loading: b })),
  setScanFailed: (b) =>
    set((s) => (s.scanFailed === b ? s : { scanFailed: b })),
}));
