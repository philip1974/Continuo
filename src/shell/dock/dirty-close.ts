// 关窗 / 退出时脏文件确认的 renderer 侧纯逻辑(main 侧见 electron/main/dirty-close-confirm.ts)。
//
// - countDirtyForClose:DockShell 在 tab 脏态变化时据此上报 main(layout:dirty-state),
//   main 关窗前按计数决定是否弹「保存 / 不保存 / 取消」。
// - saveDirtyTabsForClose:用户选「保存」时,flush 握手里先保存所有有路径的脏 tab。

import type { EditorTab } from '@/stores/editor.store';
import { isAutoSaveEnabled } from '@/panels/Editor/useAutoSave';

type TabLike = Pick<EditorTab, 'id' | 'filePath' | 'dirty'>;

export interface DirtyCloseState {
  readonly dirty: number;
  readonly untitled: number;
}

/**
 * 关窗会丢的脏 tab 数。Markdown 自动保存开启时脏 .md 不计入:关窗 flush 会经
 * flushPendingAutoSave 落盘(ADR-015:只有代码文件不 autosave)。untitled 草稿计入并单独计数。
 */
export function countDirtyForClose(
  tabs: readonly TabLike[],
  mdAutoSaveEnabled: boolean,
): DirtyCloseState {
  let dirty = 0;
  let untitled = 0;
  for (const tab of tabs) {
    if (!tab.dirty) continue;
    if (mdAutoSaveEnabled && isAutoSaveEnabled(tab.filePath)) continue;
    dirty += 1;
    if (tab.filePath === null) untitled += 1;
  }
  return { dirty, untitled };
}

/**
 * 保存所有有路径的脏 tab(含 .md,无害);untitled 无法保存(MVP 不支持另存为)直接跳过,
 * 确认框文案已说明它们会被丢弃。返回失败数(ok:false 或抛异常)。
 */
export async function saveDirtyTabsForClose(
  tabs: readonly TabLike[],
  saveTab: (tabId: string) => Promise<{ readonly ok: boolean }>,
): Promise<number> {
  const results = await Promise.all(
    tabs
      .filter((tab) => tab.dirty && tab.filePath !== null)
      .map((tab) =>
        saveTab(tab.id).then(
          (r) => r.ok,
          () => false,
        ),
      ),
  );
  return results.filter((ok) => !ok).length;
}
