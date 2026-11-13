import { create } from 'zustand';

// 置顶路径列表:随 explorer.json 的全局段读入 / 写回(见 lib/persist/explorer-persist)。当前没有置顶 / 取消
// 置顶的 UI 入口,所以这里只是持久化数据的内存落点 —— 没有修改动作(此前的 toggle / clear 无任何调用方,已删)。
type PinnedState = {
  /** 顺序保留(按持久化文件里的顺序)。 */
  paths: readonly string[];
};

const EMPTY_PINNED_PATHS: readonly string[] = [];

export const usePinnedStore = create<PinnedState>(() => ({
  paths: EMPTY_PINNED_PATHS,
}));
