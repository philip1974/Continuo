// 关窗 / 退出时脏文件确认的 renderer 侧纯逻辑(main 侧见 electron/main/dirty-close-confirm.ts)。
//
// - countDirtyForClose:DockShell 在 tab 脏态变化时据此上报 main(layout:dirty-state),
//   main 关窗前按计数决定是否弹「保存 / 不保存 / 取消」。
// - saveDirtyTabsForClose:用户选「保存」时,flush 握手里先保存所有有路径的脏 tab。
// - remainingAfterFlush:flush 握手全部落盘后、ACK 前的最终脏检查(统一规则,见 DockShell onFlushRequest)。

import type { EditorTab } from '@/stores/editor.store';
import type { DirtyState } from '../../../electron/shared/persistence-channels';
import { isAutoSaveEnabled } from '@/panels/Editor/useAutoSave';
import { willAutoSaveOnClose } from '@/panels/Editor/autosave-failures';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { EDITOR_DISK_CHANGED } from '@/panels/Editor/editor-file-actions';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { basenameForChrome } from '@/lib/path-label';
import { t } from '@/i18n';

type TabLike = Pick<EditorTab, 'id' | 'filePath' | 'dirty' | 'dirtyGen'>;

export type DirtyCloseState = DirtyState;

/**
 * 关窗会丢的脏 tab。Markdown 自动保存开启时,只有**活动** tab(持有 autosave scheduler、最近一次未失败)的
 * 脏 .md 不计入:关窗 flush 经 flushPendingAutoSave 落盘(ADR-015:只有代码文件不 autosave)。非活动的脏 .md
 * 一律计入 —— 切走时已 flush,仍脏即失败或在途,关窗 flush 不会重试(见 autosave-failures.ts)。
 */
export function countDirtyForClose(
  tabs: readonly TabLike[],
  mdAutoSaveEnabled: boolean,
): DirtyCloseState {
  const ids: string[] = [];
  const pendingAutoSave: string[] = [];
  for (const tab of tabs) {
    if (!tab.dirty) continue;
    const id = `${tab.id}#${tab.dirtyGen ?? 0}`;
    if (mdAutoSaveEnabled && isAutoSaveEnabled(tab.filePath) && willAutoSaveOnClose(tab.id)) {
      pendingAutoSave.push(id);
      continue;
    }
    ids.push(id);
  }
  return {
    dirty: ids.length,
    ids,
    ...(pendingAutoSave.length > 0 ? { pendingAutoSave } : {}),
  };
}

/**
 * 最终脏检查(统一规则):关窗 flush 全部完成(批量保存 / layout / explorer / markdown autosave flush)后仍未
 * 保存的改动。「是否允许关闭」此前只取决于弹框前的脏计数,flush 期间 / 确认期间新产生的脏状态没人再查
 * (防抖内 autosave 首次失败、保存后慢 flush 期间继续输入、多窗退出时别窗确认期间本窗变脏)。
 * autosave 已 flush 过,仍脏的 .md 也计入(不看 autosave 设置)。
 * 无 → null;有 → 全部脏 tab(main 据此记账)。
 */
export function remainingAfterFlush(tabs: readonly TabLike[]): DirtyCloseState | null {
  const state = countDirtyForClose(tabs, false);
  return state.dirty > 0 ? state : null;
}

/**
 * 「不保存」分支的最终检查(终审 P1):用户只同意丢弃确认框列出的文件;确认时未列入框的待 autosave .md
 * (main 随 flush 请求带来的 pendingAutoSave 身份)flush 后仍脏(保存失败)→ 不能静默丢弃。按 tabId 匹配
 * (忽略变脏代际:flush 失败后的再次变脏同样未被告知)。无 → null;有 → 全部脏 tab(main 据此记账,再次关闭时进确认框)。
 */
export function remainingAfterDiscard(
  tabs: readonly TabLike[],
  pendingAutoSaveIds: readonly string[],
): DirtyCloseState | null {
  const pendingTabIds = new Set(
    pendingAutoSaveIds.map((id) => {
      const sep = id.lastIndexOf('#');
      return sep < 0 ? id : id.slice(0, sep);
    }),
  );
  if (!tabs.some((tab) => tab.dirty && pendingTabIds.has(tab.id))) return null;
  return countDirtyForClose(tabs, false);
}

export interface SaveForCloseResult {
  /** 未保存成功的 tab 数(ok:false / 抛异常 / 保存完成后仍脏)。 */
  readonly failed: number;
  /** 其中因磁盘已被外部修改(EDITOR_DISK_CHANGED)而未写的数,提示里单独说明。 */
  readonly diskChanged: number;
  /** 其中因文件写保护(FS_READONLY)而未写的数,提示里单独说明(关窗流程不弹覆盖框)。 */
  readonly readonly: number;
  /** 未保存成功的文件路径(按输入顺序),提示里列出前几个。 */
  readonly failedPaths: readonly string[];
}

/** 关窗保存失败提示里最多列出的文件名数(其余以「等」概括)。 */
const FAILED_NAMES_SHOWN = 3;

/**
 * 关窗「保存」失败的 toast 文案:失败数 + 前几个文件名;磁盘冲突 / 写保护各追加一句出路(在编辑器按保存键处理,
 * 或选「不保存」)。hotkey 为当前生效的保存键。
 */
export function saveForCloseFailureMessage(r: SaveForCloseResult, hotkey: string): string {
  const shown = r.failedPaths.slice(0, FAILED_NAMES_SHOWN).map(basenameForChrome);
  const joined = shown.join(t('common.list_separator'));
  const names = r.failedPaths.length > shown.length ? t('dialog.unsaved_close.names_more', { names: joined }) : joined;
  const parts = [t('dialog.unsaved_close.save_failed', { count: r.failed, names })];
  if (r.diskChanged > 0) parts.push(t('dialog.unsaved_close.disk_changed_note', { count: r.diskChanged, hotkey }));
  if (r.readonly > 0) parts.push(t('dialog.unsaved_close.readonly_note', { count: r.readonly, hotkey }));
  // 句间分隔随语言(中文全角句号后不加空格)。
  return parts.join(t('common.sentence_separator'));
}

/**
 * 保存所有脏 tab(含 .md,无害)。
 * 复审:保存期间用户继续输入 → saveFile 返回 ok 但 tab 仍脏(markSaved 保留 dirty);只看返回值会
 * 报成功并关窗丢新输入。全部完成后用 getTabs() 复查,仍脏的同样计为失败。
 */
/**
 * perf:关窗「保存」时同时在途的保存数上限。每个保存含整文件读比对 + writeFile fsync,原 Promise.all
 * 全并发在数百个大文件时 main 峰值内存与 fsync 并发失控。
 */
export const SAVE_FOR_CLOSE_CONCURRENCY = 32;

export async function saveDirtyTabsForClose(
  tabs: readonly TabLike[],
  saveTab: (tabId: string) => Promise<{ readonly ok: boolean; readonly code?: string }>,
  getTabs: () => readonly TabLike[],
): Promise<SaveForCloseResult> {
  const targets = tabs.filter((tab) => tab.dirty);
  // 有界并发(结果按下标对位,单个 reject 记为失败,同原 Promise.all + catch 语义)。
  const settled = await allSettledWithConcurrency(targets, SAVE_FOR_CLOSE_CONCURRENCY, (tab) =>
    saveTab(tab.id),
  );
  const current = getTabs();
  const failedPaths: string[] = [];
  let diskChanged = 0;
  let readonly = 0;
  for (let i = 0; i < targets.length; i += 1) {
    const s = settled[i]!;
    const r = s.status === 'fulfilled' ? s.value : ({ ok: false } as const);
    if (!r.ok) {
      failedPaths.push(targets[i]!.filePath);
      if ('code' in r && r.code === EDITOR_DISK_CHANGED) diskChanged += 1;
      else if ('code' in r && r.code === ERROR_CODES.FS_READONLY) readonly += 1;
    } else if (current.some((tab) => tab.id === targets[i]!.id && tab.dirty)) {
      failedPaths.push(targets[i]!.filePath);
    }
  }
  return { failed: failedPaths.length, diskChanged, readonly, failedPaths };
}
