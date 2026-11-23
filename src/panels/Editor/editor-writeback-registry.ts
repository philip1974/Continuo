// 编辑器「同步回写」句柄注册表(仿 autosave-flush-registry 的 registerAutoSaveFlush)。
//
// Milkdown 的上抛有 200ms 起的防抖(plugin-listener 的 lodash debounce,大文档再按序列化耗时拉长),
// 销毁时不 flush。关窗 flush 握手只落盘 store 里的内容 → 最后 <200ms 的输入还没进 store 就随
// 窗口销毁丢失。活动 Milkdown 把「从编辑器同步取全文写回 store」的句柄登记在这里,DockShell
// 关窗握手在保存 / autosave flush 之前先调 flushEditorWriteBacks()。


// 按 tab id 登记:回写会把编辑器整篇序列化(大文档约 70ms)并提前上抛,只该回写受影响的 tab ——
// 例如外部改了另一个打开中的干净文件(reloadFromDisk)不应打断正在输入的 tab。同一 tab id 允许
// 多个句柄(卸载与新挂载交替的过渡期 / 将来多视图),故值为 Set。
const writeBacks = new Map<string, Set<() => void>>();

/** 登记 tab `tabId` 的同步回写句柄,返回注销函数。 */
export function registerEditorWriteBack(tabId: string, fn: () => void): () => void {
  let set = writeBacks.get(tabId);
  if (!set) {
    set = new Set();
    writeBacks.set(tabId, set);
  }
  set.add(fn);
  return () => {
    const cur = writeBacks.get(tabId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) writeBacks.delete(tabId);
  };
}

function runWriteBack(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn('[editor] write-back failed', err);
  }
}

/**
 * 同步执行已登记的回写(单个失败不影响其它,不阻断关窗)。省略 `tabIds` = 全部(关窗 / 切全局 mode);
 * 传入则只回写这些 tab 的句柄。
 */
export function flushEditorWriteBacks(tabIds?: Iterable<string>): void {
  if (tabIds === undefined) {
    for (const set of [...writeBacks.values()]) for (const fn of [...set]) runWriteBack(fn);
    return;
  }
  for (const id of tabIds) {
    const set = writeBacks.get(id);
    if (set) for (const fn of [...set]) runWriteBack(fn);
  }
}
