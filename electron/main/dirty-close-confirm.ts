// 关窗 / 退出时脏文件确认(纯函数,可单测;electron 依赖由调用方注入)。
//
// 代码文件不 autosave(ADR-015),此前关窗 / Cmd+Q 直接 flush 后关闭,脏 tab 静默丢失。
// 参考 VSCode:关闭含未保存改动的窗口弹「是否保存对 a.ts 的更改?」/「是否保存对以下 N 个文件的更改?」(逐行列出文件名)
// 保存(全部保存)/ 不保存 / 取消。
// renderer 在脏态变化时经 layout:dirty-state 上报计数与脏 tab id(main 按窗口存),关窗时据此决定是否弹框;
// 选「保存」时 flush 请求带 save:true,renderer 先保存再 flush,回执里带 saveFailed。

import { basename } from 'node:path';
import type { MainT } from './i18n';
import { PATH_ARRAY_MAX, PATH_STR_MAX } from '../shared/explorer-persistence-schema';
import type { DirtyState, FlushAckPayload } from '../shared/persistence-channels';

export type { DirtyState };

// 边界:id 列表上限对齐 openFilePaths(PATH_ARRAY_MAX)、单条对齐 PATH_STR_MAX,防畸形 / 篡改上报。
// id 形如 `${tabId}#${dirtyGen}`:tabId 本身可达 PATH_STR_MAX(Windows 长路径),单条上限给代际后缀留余量,
// 否则合法打开的长路径文件整份上报被拒 → 关窗不弹确认、静默丢修改。
const DIRTY_ID_MAX = PATH_STR_MAX + 32;
function parseIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > PATH_ARRAY_MAX) return null;
  for (const id of v) {
    if (typeof id !== 'string' || id.length === 0 || id.length > DIRTY_ID_MAX) return null;
  }
  return new Set(v).size === v.length ? (v as string[]) : null;
}

/** 解析 renderer 上报;任何不合法输入(含计数与 id 列表不一致)→ null(调用方忽略该上报)。 */
export function parseDirtyState(raw: unknown): DirtyState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const ids = parseIds(obj['ids']);
  if (!ids || obj['dirty'] !== ids.length) return null;
  const pending = obj['pendingAutoSave'] === undefined ? [] : parseIds(obj['pendingAutoSave']);
  if (!pending) return null;
  return {
    dirty: ids.length,
    ids,
    ...(pending.length > 0 ? { pendingAutoSave: pending } : {}),
  };
}

export function needsDirtyConfirm(state: DirtyState | undefined): state is DirtyState {
  return state !== undefined && state.dirty > 0;
}

export type DirtyCloseChoice = 'save' | 'discard' | 'cancel';

// 按钮下标:与 buttons 顺序一致。
const SAVE_ID = 0;
const DISCARD_ID = 1;
const CANCEL_ID = 2;

export interface DirtyCloseDialogOptions {
  readonly type: 'warning';
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: true;
  readonly message: string;
  readonly detail: string;
}

/** 确认框里最多逐行列出的文件名数(VSCode getFileNamesMessage MAX_CONFIRM_FILES),其余一行概括。 */
export const DIRTY_CLOSE_MAX_NAMES = 10;

/** 脏 tab 身份 `${tabId}#${代际}`(tabId = 文件路径)→ 文件名。路径来自本机,按本机分隔符取 basename。 */
function dirtyIdFileName(id: string): string {
  const sep = id.lastIndexOf('#');
  return basename(sep < 0 ? id : id.slice(0, sep));
}

/**
 * VSCode showSaveConfirm:1 个文件 → 标题写文件名、按钮「保存」;多个 → 标题写数量、按钮「全部保存」,detail 逐行列出文件名
 * (最多 DIRTY_CLOSE_MAX_NAMES 个),空一行后是丢失提示。文件名由脏态 id 推出(id 本身就是路径,不另加上报字段)。
 */
export function buildDirtyCloseDialog(state: DirtyState, t: MainT): DirtyCloseDialogOptions {
  const single = state.ids.length === 1;
  const lossNote = t('dialog.unsaved_close.detail');
  let message: string;
  let detail = lossNote;
  if (single) {
    message = t('panels.editor.save_changes_title', { name: dirtyIdFileName(state.ids[0]!) });
  } else {
    message = t('dialog.unsaved_close.message', { count: state.dirty });
    const lines = state.ids.slice(0, DIRTY_CLOSE_MAX_NAMES).map(dirtyIdFileName);
    const more = state.ids.length - lines.length;
    // 单复数按 en 规则选 key(zh / ko 两条同文);main 侧无 translateCount。
    if (more > 0) lines.push(t(more === 1 ? 'dialog.unsaved_close.more_one' : 'dialog.unsaved_close.more_other', { count: more }));
    detail = [...lines, '', lossNote].join('\n');
  }
  return {
    type: 'warning',
    buttons: [
      t(single ? 'common.save' : 'dialog.unsaved_close.save_all'),
      t('dialog.unsaved_close.dont_save'),
      t('common.cancel'),
    ],
    defaultId: SAVE_ID,
    cancelId: CANCEL_ID,
    noLink: true,
    message,
    detail,
  };
}

/** 弹确认框并映射选择。对话框异常按取消处理(宁可不关也不丢数据)。 */
export async function askDirtyClose(
  state: DirtyState,
  t: MainT,
  show: (opts: DirtyCloseDialogOptions) => Promise<{ response: number }>,
): Promise<DirtyCloseChoice> {
  let response: number;
  try {
    ({ response } = await show(buildDirtyCloseDialog(state, t)));
  } catch (err) {
    console.warn('[dirty-close] confirm dialog failed', err);
    return 'cancel';
  }
  if (response === SAVE_ID) return 'save';
  if (response === DISCARD_ID) return 'discard';
  return 'cancel';
}

/**
 * 解析 flush 回执的结果参数(无该参数 → 未失败)。requestId 为安全正整数才采纳,否则 null
 * (缺失 / 畸形值;调用方只结算与在途请求匹配的回执,null 即不结算)。
 * remaining:renderer 在全部 flush 完成后做最终脏检查,仍有未保存改动(且本轮未选「不保存」)时带回计数;
 * 合法且 dirty>0 才采纳,否则 null。main 据此中止关闭 / 退出并记账(下次关闭弹确认)。
 * state:flush 后的最终脏态(renderer 始终携带,含空集合);合法即采纳(旧回执 / 畸形 → null),main 以其更新
 * 脏态记账 —— 不等之后的脏态上报,退出前全局最终检查用的就是回执时的状态(复审)。
 */
export function parseFlushAck(raw: unknown): {
  saveFailed: boolean;
  requestId: number | null;
  remaining: DirtyState | null;
  state: DirtyState | null;
} {
  // 字段名受 shared FlushAckPayload 约束(与 preload 发送侧同一来源),值仍按 unknown 逐个校验。
  const obj: { readonly [K in keyof FlushAckPayload]?: unknown } =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const saveFailed = obj['saveFailed'] === true;
  const id = obj['requestId'];
  const requestId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  const remaining = parseDirtyState(obj['remaining']);
  return {
    saveFailed,
    requestId,
    remaining: needsDirtyConfirm(remaining ?? undefined) ? remaining : null,
    state: parseDirtyState(obj['state']),
  };
}
