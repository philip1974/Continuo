// 用户主动打开文件失败的统一提示(Explorer 点击文件 / Quick Open 选中文件 / 编辑器内文件链接共用;此前两处各写一份并已分叉),
// 以及编辑器保存失败提示(同一「动作 文件名：原因」格式)。
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { failureOf, type Failure } from '@/lib/failure-of';
import { notify } from './notify';

/** `「打开失败」 <name>：<按 code 本地化的原因>`(冒号随语言),toast 附 code。调用方已自行 console 记录时传 mirror:false。 */
export function notifyOpenFailed(
  name: string,
  failure: Failure,
  opts?: { readonly mirror: false },
): void {
  notify.error(
    fileFailureText(t('quick_open.open_failed'), name, failure),
    opts ? { code: failure.code, mirror: false } : { code: failure.code },
  );
}

/**
 * 保存失败的统一提示(显式保存 / 关闭时保存 / 覆盖确认后的重试):`「保存失败」 <name>：<原因>`,同 VSCode
 * 「Failed to save 'note.txt': …」—— 此前只弹按 code 本地化的原因(如「文件 I/O 错误」),看不出是哪个文件、什么动作。
 */
export function notifySaveFailed(name: string, failure: Failure): void {
  notify.error(fileFailureText(t('editor.save_failed'), name, failure), { code: failure.code });
}

/** `<动作> <文件名>：<按 code 本地化的原因>`(冒号随语言)。打开 / 保存 / 自动保存失败共用。 */
export function fileFailureText(action: string, name: string, failure: Failure): string {
  const reason = localizeErrorByCode(failure.code, failure.message);
  return t('common.label_detail', { label: `${action} ${name}`, detail: reason });
}

/**
 * 打开文件并在失败时提示:`ok:false` 结果与 reject 两个分支都走 notifyOpenFailed(此前 Explorer / Quick Open / 编辑器
 * 链接三处各自 try / then-catch,历史上多次只处理了一个分支 —— A127 / A141 / P1-AX)。给 logTag 时由这里记 console
 * 并关闭 toast 的 mirror(避免双写)。不抛;返回是否打开成功(成功后要不要把焦点交给编辑器由调用方定)。
 */
export async function openFileOrNotify(
  open: () => Promise<{ readonly ok: true } | ({ readonly ok: false } & Failure)>,
  name: string,
  logTag?: string,
): Promise<boolean> {
  let failure: Failure | null = null;
  try {
    const r = await open();
    if (!r.ok) failure = r;
  } catch (err) {
    failure = failureOf(err);
  }
  if (failure === null) return true;
  if (logTag === undefined) {
    notifyOpenFailed(name, failure);
    return false;
  }
  console.warn(`[${logTag}] open file failed:`, failure.code, failure.message);
  notifyOpenFailed(name, failure, { mirror: false });
  return false;
}

