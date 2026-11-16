// 关窗 / 退出时脏文件确认的 renderer 侧纯逻辑(main 侧见 electron/main/dirty-close-confirm.ts)。
//
// - countDirtyForClose:DockShell 在 tab 脏态变化时据此上报 main(layout:dirty-state),
//   main 关窗前按计数决定是否弹「保存 / 不保存 / 取消」。
// - saveDirtyTabsForClose:用户选「保存」时,flush 握手里先保存所有有路径的脏 tab。

import type { EditorTab } from '@/stores/editor.store';
import { isAutoSaveEnabled } from '@/panels/Editor/useAutoSave';
import { isAutoSaveFailed } from '@/panels/Editor/autosave-failures';

type TabLike = Pick<EditorTab, 'id' | 'filePath' | 'dirty'>;

export interface DirtyCloseState {
  readonly dirty: number;
  readonly untitled: number;
}

/**
 * 关窗会丢的脏 tab 数。Markdown 自动保存开启时脏 .md 不计入:关窗 flush 会经
 * flushPendingAutoSave 落盘(ADR-015:只有代码文件不 autosave)。例外:最近一次 autosave 失败的
 * 脏 .md 计入 —— 失败后无 pending timer,flush 不会重试(复审)。untitled 草稿计入并单独计数。
 */
export function countDirtyForClose(
  tabs: readonly TabLike[],
  mdAutoSaveEnabled: boolean,
): DirtyCloseState {
  let dirty = 0;
  let untitled = 0;
  for (const tab of tabs) {
    if (!tab.dirty) continue;
    if (mdAutoSaveEnabled && isAutoSaveEnabled(tab.filePath) && !isAutoSaveFailed(tab.id)) continue;
    dirty += 1;
    if (tab.filePath === null) untitled += 1;
  }
  return { dirty, untitled };
}

export interface SaveForCloseResult {
  /** 未保存成功的 tab 数(ok:false / 抛异常 / 保存完成后仍脏)。 */
  readonly failed: number;
  /** 其中因磁盘已被外部修改(EDITOR_DISK_CHANGED)而未写的数,提示里单独说明。 */
  readonly diskChanged: number;
}

/**
 * 保存所有有路径的脏 tab(含 .md,无害);untitled 无法保存(MVP 不支持另存为)直接跳过,
 * 确认框文案已说明它们会被丢弃。
 * 复审:保存期间用户继续输入 → saveFile 返回 ok 但 tab 仍脏(markSaved 保留 dirty);只看返回值会
 * 报成功并关窗丢新输入。全部完成后用 getTabs() 复查,仍脏的同样计为失败。
 */
export async function saveDirtyTabsForClose(
  tabs: readonly TabLike[],
  saveTab: (tabId: string) => Promise<{ readonly ok: boolean; readonly code?: string }>,
  getTabs: () => readonly TabLike[],
): Promise<SaveForCloseResult> {
  const targets = tabs.filter((tab) => tab.dirty && tab.filePath !== null);
  const results = await Promise.all(
    targets.map((tab) =>
      saveTab(tab.id).then(
        (r) => r,
        () => ({ ok: false }) as const,
      ),
    ),
  );
  const current = getTabs();
  let failed = 0;
  let diskChanged = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const r = results[i]!;
    if (!r.ok) {
      failed += 1;
      if ('code' in r && r.code === 'EDITOR_DISK_CHANGED') diskChanged += 1;
    } else if (current.some((tab) => tab.id === targets[i]!.id && tab.dirty)) {
      failed += 1;
    }
  }
  return { failed, diskChanged };
}
