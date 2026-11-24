// 主进程发起的「开新窗口」(菜单 / Dock 菜单 / open-file / second-instance / 冷启动多目录)的失败兜底。
// 开窗先在 explorer.json 分配 windowSeq(读 + 写),磁盘满 / 无权限会 reject;入口都是 fire-and-forget,
// 不兜住则用户无任何提示且产生 unhandled rejection。renderer 的 window.create 失败由 renderer 自己
// notify;main 没有推送通道,这里直接弹原生错误对话框(同 VSCode 主进程 dialogMainService.showMessageBox)。
import { errorMessage, thrownFields } from '../../shared/error-message';
import type { MainT } from '../i18n';
import { mapNodeErrnoCode } from '../ipc/fs/path-utils';

export interface WindowOpenFailureUi {
  /** 失败当时取当前语言的 t(语言可能在运行期切换)。 */
  readonly t: () => MainT;
  readonly showError: (message: string, detail: string) => void;
}

/** 原因:带已收录业务码按 `errors.<CODE>`,否则 node errno 经 mapNodeErrnoCode 归到 FS_* 文案。 */
function failureReason(err: unknown, t: MainT): string {
  const { code } = thrownFields(err);
  if (code !== undefined) {
    const key = `errors.${code}`;
    const localized = t(key);
    if (localized !== key) return localized;
  }
  const errPath = (err as { path?: unknown } | null)?.path;
  return t(`errors.${mapNodeErrnoCode({ code })}`, { path: typeof errPath === 'string' ? errPath : '' });
}

/** 执行开窗;失败(含同步抛出)不外泄,提示用户后返回 undefined。 */
export async function runWindowOpen<T>(
  fn: () => Promise<T>,
  ui: WindowOpenFailureUi,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.warn('[window-open] failed', err);
    try {
      const t = ui.t();
      const reason = failureReason(err, t);
      const raw = errorMessage(err);
      ui.showError(t('menu.file.window_open_failed'), raw && raw !== reason ? `${reason}\n\n${raw}` : reason);
    } catch (uiErr) {
      console.warn('[window-open] failure prompt failed', uiErr);
    }
    return undefined;
  }
}
