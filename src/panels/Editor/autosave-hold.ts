// 按路径暂停自动保存:Explorer 删除确认框打开期间、以及移到废纸篓在途期间,被删路径(及其子路径)下的 tab 不自动保存
// —— 否则停留超过自动保存延迟就把待删文件的未保存修改写盘,删除后 tab 已不脏被直接关闭,与框内「编辑器保留并
// 标记为已删除,不会写回磁盘」矛盾。同 EditorPanel 关闭脏 tab 的确认框开着时暂停 autosave。
// BDD: src/__tests__/editor-orphaned-tab/orphaned-trash-confirm.spec.tsx

import { create } from 'zustand';
import { isSameOrInsidePath } from '@/lib/path-cross';

interface AutoSaveHoldState {
  /** 每次 holdAutoSave 一项(同一路径可被多处同时暂停,各自释放)。 */
  readonly holds: ReadonlyArray<readonly string[]>;
}

const useAutoSaveHoldStore = create<AutoSaveHoldState>(() => ({ holds: [] }));

/** 暂停 paths(含子路径)下 tab 的自动保存,返回释放函数(重复调用无副作用)。 */
export function holdAutoSave(paths: readonly string[]): () => void {
  const entry = [...paths];
  useAutoSaveHoldStore.setState((s) => ({ holds: [...s.holds, entry] }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useAutoSaveHoldStore.setState((s) => ({ holds: s.holds.filter((h) => h !== entry) }));
  };
}

/** filePath 当前是否被暂停自动保存。 */
export function useAutoSaveHeld(filePath: string | null): boolean {
  return useAutoSaveHoldStore(
    (s) => filePath !== null && s.holds.some((paths) => paths.some((p) => isSameOrInsidePath(p, filePath))),
  );
}
