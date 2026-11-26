// 批量关闭编辑器 tab(右键「关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭」,单个关闭同一路径)的推进逻辑。
// 只有 1 个脏 tab:逐个确认(保存 / 不保存 / 取消,确认前切到该 tab;VSCode editorGroupView.handleCloseConfirmation)。
// 多于 1 个:先弹一个合并框列出全部脏文件(VSCode showSaveConfirm「全部保存 / 不保存 / 取消」),「全部保存」= saveAll
// 进度,按顺序逐个保存、不再逐个问。全部处理完才一起关闭;任一处取消 / 失败 → 整批都不关。
// BDD: src/__tests__/tab-context-menu/

import type { TabChrome } from './EditorHeader';

/** 批量关闭的进度:rest = 还要确认的 tab(按顺序);closeIds = 确认完后要关闭的全部 tab。 */
export interface BatchClose {
  readonly rest: readonly string[];
  readonly closeIds: readonly string[];
  /** 合并框里选了「全部保存」:rest 里的脏 tab 直接保存,不再逐个确认。 */
  readonly saveAll?: boolean;
}

export type BatchCloseStep =
  | { readonly kind: 'confirm'; readonly tab: TabChrome; readonly batch: BatchClose }
  | { readonly kind: 'close'; readonly ids: readonly string[] };

/**
 * 下一步:rest 里下一个仍存在且脏的 tab → 确认它(batch 为确认之后的进度);没有 → 关闭 closeIds 中仍存在的 tab。
 */
export function nextBatchCloseStep(
  tabs: readonly Pick<TabChrome, 'id' | 'filePath' | 'dirty'>[],
  progress: BatchClose,
): BatchCloseStep {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  for (let i = 0; i < progress.rest.length; i += 1) {
    const tab = byId.get(progress.rest[i]!);
    if (tab?.dirty) {
      return {
        kind: 'confirm',
        tab: { id: tab.id, filePath: tab.filePath, dirty: true },
        batch: { ...progress, rest: progress.rest.slice(i + 1) },
      };
    }
  }
  return { kind: 'close', ids: progress.closeIds.filter((id) => byId.has(id)) };
}

/** 这批里仍存在且脏的 tab(按 rest 顺序):多于 1 个时先弹合并确认框。 */
export function dirtyTabsInBatch(
  tabs: readonly Pick<TabChrome, 'id' | 'filePath' | 'dirty'>[],
  progress: BatchClose,
): Pick<TabChrome, 'id' | 'filePath'>[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  return progress.rest.flatMap((id) => {
    const tab = byId.get(id);
    return tab?.dirty ? [{ id: tab.id, filePath: tab.filePath }] : [];
  });
}
