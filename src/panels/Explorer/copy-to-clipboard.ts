import { getCachedClipboard } from '@/plugins/sandbox-sweep';
import { notify } from '@/notifications/notify';

/**
 * a11y(A48,A46/A47 同族):写系统剪贴板,失败时给可见 + 可播报反馈(notify toast),不静默。
 *
 * 复制路径等操作此前失败只 console.warn → 用户(尤其键盘/屏幕阅读器)以为已复制成功。失败
 * 文案由调用方传入(已本地化;design/lib 层不持 i18n)。成功不打扰。
 */
export async function copyToClipboardOrNotify(
  text: string,
  failMessage: string,
): Promise<void> {
  try {
    await getCachedClipboard().writeText(text);
  } catch (err) {
    console.warn('[explorer] clipboard write failed', err);
    notify.error(failMessage);
  }
}
