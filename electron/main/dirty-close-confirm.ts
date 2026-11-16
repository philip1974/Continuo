// 关窗 / 退出时脏文件确认(纯函数,可单测;electron 依赖由调用方注入)。
//
// 代码文件不 autosave(ADR-015),此前关窗 / Cmd+Q 直接 flush 后关闭,脏 tab 静默丢失。
// 参考 VSCode:关闭含未保存改动的窗口弹「是否保存 N 个文件的更改?」保存 / 不保存 / 取消。
// renderer 在脏态变化时经 layout:dirty-state 上报计数(main 按窗口存),关窗时据此决定是否弹框;
// 选「保存」时 flush 请求带 save:true,renderer 先保存再 flush,回执里带 saveFailed。

import type { MainT } from './i18n';

export interface DirtyState {
  /** 关窗会丢的脏 tab 数(含 untitled)。 */
  readonly dirty: number;
  /** 其中 untitled 草稿数(无路径,MVP 不支持另存为,「保存」时跳过)。 */
  readonly untitled: number;
}

// 边界:计数上限(远超真实 tab 数),防畸形 / 篡改上报。
const DIRTY_COUNT_MAX = 100_000;

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= DIRTY_COUNT_MAX;
}

/** 解析 renderer 上报;任何不合法输入 → null(调用方忽略该上报)。 */
export function parseDirtyState(raw: unknown): DirtyState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { dirty, untitled } = raw as Record<string, unknown>;
  if (!isCount(dirty) || !isCount(untitled) || untitled > dirty) return null;
  return { dirty, untitled };
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

export function buildDirtyCloseDialog(state: DirtyState, t: MainT): DirtyCloseDialogOptions {
  let detail = t('dialog.unsaved_close.detail');
  if (state.untitled > 0) {
    detail += `\n\n${t('dialog.unsaved_close.untitled_note', { count: state.untitled })}`;
  }
  return {
    type: 'warning',
    buttons: [t('common.save'), t('dialog.unsaved_close.dont_save'), t('common.cancel')],
    defaultId: SAVE_ID,
    cancelId: CANCEL_ID,
    noLink: true,
    message: t('dialog.unsaved_close.message', { count: state.dirty }),
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

/** 解析 flush 回执的结果参数(旧格式无该参数 → 未失败)。 */
export function parseFlushAck(raw: unknown): { saveFailed: boolean } {
  const saveFailed =
    typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['saveFailed'] === true;
  return { saveFailed };
}
