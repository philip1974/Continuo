// 编辑器「同步回写」句柄注册表(仿 autosave-flush-registry 的 registerAutoSaveFlush)。
//
// Milkdown 的 @milkdown/plugin-listener 对 markdownUpdated 有 200ms 防抖(lodash debounce),
// 销毁时不 flush。关窗 flush 握手只落盘 store 里的内容 → 最后 <200ms 的输入还没进 store 就随
// 窗口销毁丢失。活动 Milkdown 把「从编辑器同步取全文写回 store」的句柄登记在这里,DockShell
// 关窗握手在保存 / autosave flush 之前先调 flushEditorWriteBacks()。

import { findEditorFileTabById } from './editor-tab-lookup';
import type { useEditorStore } from '@/stores/editor.store';

const writeBacks = new Set<() => void>();

/** 登记一个同步回写句柄,返回注销函数。 */
export function registerEditorWriteBack(fn: () => void): () => void {
  writeBacks.add(fn);
  return () => {
    writeBacks.delete(fn);
  };
}

/** 同步执行所有已登记的回写(单个失败不影响其它,不阻断关窗)。 */
export function flushEditorWriteBacks(): void {
  for (const fn of writeBacks) {
    try {
      fn();
    } catch (err) {
      console.warn('[editor] write-back failed', err);
    }
  }
}

/**
 * 把编辑器回写的全文写入 tab。`base` 是编辑器最近一次上抛(或挂载时)的内容:store 里该 tab
 * 内容已不等于 base → 期间被别处改过(外部改盘 reloadFromDisk 触发 epoch 重挂载等),不用旧
 * 编辑器的内容覆盖。tab 已关闭 → no-op。
 */
export function applyEditorWriteBack(
  store: typeof useEditorStore,
  tabId: string,
  markdown: string,
  base: string,
): void {
  const cur = findEditorFileTabById(store.getState().tabs, tabId);
  if (!cur || cur.content !== base) return;
  store.getState().updateContent(tabId, markdown);
}
