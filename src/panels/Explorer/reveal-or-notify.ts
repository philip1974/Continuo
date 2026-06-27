import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import { localizeErrorByCode } from '@/lib/localize-error';

/**
 * a11y(A49,A47/A48 同族):在系统文件管理器(Finder/资源管理器)显示路径,失败时给可见 +
 * 可播报反馈(notify toast),不静默 console.warn —— 否则用户(尤其键盘/屏幕阅读器)只看到
 * 菜单关闭却不知 reveal 失败。错误按 code 本地化。
 */
export async function revealPathOrNotify(path: string): Promise<void> {
  // a11y(A145,A141 同族):reveal() 的 IPC reject(抛错而非返回 {ok:false})此前未捕获 →
  // 菜单 onClick 的 fire-and-forget 调用变 unhandled rejection,reveal 异常时菜单关闭却无反馈。
  try {
    const r = await coApi.fs.reveal(path);
    if (!r.ok) {
      console.warn('[explorer] reveal failed', r.code, r.message);
      notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
    }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'EXCEPTION';
    console.warn('[explorer] reveal rejected', code, err);
    notify.error(localizeErrorByCode(code, (err as Error)?.message ?? code), { code });
  }
}
