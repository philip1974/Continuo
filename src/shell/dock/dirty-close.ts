// 关窗 / 退出时脏文件确认的 renderer 侧纯逻辑(main 侧见 electron/main/dirty-close-confirm.ts)。
//
// - countDirtyForClose:DockShell 在 tab 脏态变化时据此上报 main(layout:dirty-state),
//   main 关窗前按计数决定是否弹「保存 / 不保存 / 取消」。
// - saveDirtyTabsForClose:用户选「保存」时,flush 握手里先保存所有有路径的脏 tab。
// - remainingAfterFlush:flush 握手全部落盘后、ACK 前的最终脏检查(统一规则,见 DockShell onFlushRequest)。

import type { EditorTab } from '@/stores/editor.store';
import { isAutoSaveEnabled } from '@/panels/Editor/useAutoSave';
import { willAutoSaveOnClose } from '@/panels/Editor/autosave-failures';

type TabLike = Pick<EditorTab, 'id' | 'filePath' | 'dirty'>;

export interface DirtyCloseState {
  readonly dirty: number;
  readonly untitled: number;
  /** 脏 tab 的 id(file tab = 路径;untitled = 其 id)。main 按身份比较「本轮已接受」的范围(复审:只比数量会被同数量替换绕过)。 */
  readonly ids: readonly string[];
  /** 其中 untitled 的 id(⊆ ids)。 */
  readonly untitledIds: readonly string[];
}

/**
 * 关窗会丢的脏 tab。Markdown 自动保存开启时,只有**活动** tab(持有 autosave scheduler、最近一次未失败)的
 * 脏 .md 不计入:关窗 flush 经 flushPendingAutoSave 落盘(ADR-015:只有代码文件不 autosave)。非活动的脏 .md
 * 一律计入 —— 切走时已 flush,仍脏即失败或在途,关窗 flush 不会重试(见 autosave-failures.ts)。
 * untitled 草稿计入并单独计数。
 */
export function countDirtyForClose(
  tabs: readonly TabLike[],
  mdAutoSaveEnabled: boolean,
): DirtyCloseState {
  const ids: string[] = [];
  const untitledIds: string[] = [];
  for (const tab of tabs) {
    if (!tab.dirty) continue;
    if (mdAutoSaveEnabled && isAutoSaveEnabled(tab.filePath) && willAutoSaveOnClose(tab.id))
      continue;
    ids.push(tab.id);
    if (tab.filePath === null) untitledIds.push(tab.id);
  }
  return { dirty: ids.length, untitled: untitledIds.length, ids, untitledIds };
}

/**
 * 最终脏检查(统一规则):关窗 flush 全部完成(批量保存 / layout / explorer / markdown autosave flush)后仍未
 * 保存的改动。「是否允许关闭」此前只取决于弹框前的脏计数,flush 期间 / 确认期间新产生的脏状态没人再查
 * (防抖内 autosave 首次失败、保存后慢 flush 期间继续输入、多窗退出时别窗确认期间本窗变脏)。
 * autosave 已 flush 过,仍脏的 .md 也计入(不看 autosave 设置);untitled 计入,但本轮选了「保存」时
 * 用户已被告知确认框里的 untitled 会被丢弃 —— 只放过确认框告知的 untitled id(allowedUntitledIds,main 随
 * flush 请求带来);确认后才新建的 untitled 草稿即计入(复审:此前按数量放过,同数量替换会被静默丢弃)。
 * 无 → null;有 → 全部脏 tab(main 据此记账)。
 */
export function remainingAfterFlush(
  tabs: readonly TabLike[],
  allowedUntitledIds: ReadonlySet<string>,
): DirtyCloseState | null {
  const state = countDirtyForClose(tabs, false);
  const allowed = state.untitledIds.filter((id) => allowedUntitledIds.has(id)).length;
  return state.dirty - allowed > 0 ? state : null;
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
