// M-Editor Step E2:useAutoSave 薄壳 hook。
// 监听全局 activeTab 内容变化,enabled=true 时按 delayMs 防抖触发 saveFile。
//
// 决策(ADR-015):Markdown 自动保存,代码必须显式 Cmd+S。
// enabled 由 EditorPanel 根据当前 tab 文件类型决定(.md/.markdown → true)。

import { useEffect, useMemo } from 'react';
import { useEditorStore } from '@/stores/editor.store';
import { makeAutoSaveScheduler } from './auto-save';

const DEFAULT_DELAY_MS = 2000;

export interface UseAutoSaveOptions {
  enabled: boolean;
  /** 默认 2000ms(决策 #3). */
  delayMs?: number;
}

export function useAutoSave(
  saveFile: () => Promise<unknown>,
  opts: UseAutoSaveOptions,
): void {
  const { enabled, delayMs = DEFAULT_DELAY_MS } = opts;
  // 订阅活跃 tab 的关键字段,变化即重排 schedule
  const activeTab = useEditorStore((s) =>
    s.tabs.find((t) => t.id === s.activeTabId) ?? null,
  );

  // scheduler 单例(以 saveFile + delayMs 为身份)
  const scheduler = useMemo(
    () => makeAutoSaveScheduler(saveFile, delayMs),
    [saveFile, delayMs],
  );

  useEffect(() => {
    if (!enabled) return;
    if (!activeTab) return;
    if (!activeTab.filePath) return;
    if (!activeTab.dirty) return;
    scheduler.schedule();
    return () => scheduler.cancel();
  }, [enabled, activeTab, scheduler]);

  // 卸载时彻底取消
  useEffect(() => () => scheduler.cancel(), [scheduler]);
}

/**
 * 根据 filePath 判断是否启用自动保存.
 * 决策 #3:.md / .markdown 自动保存;其它(代码 / 任意)显式 Cmd+S。
 */
export function isAutoSaveEnabled(filePath: string | null): boolean {
  if (!filePath) return false;
  return /\.(md|markdown)$/i.test(filePath);
}
