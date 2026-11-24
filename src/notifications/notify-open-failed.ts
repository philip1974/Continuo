// 用户主动打开文件失败的统一提示(Explorer 点击文件 / Quick Open 选中文件共用;此前两处各写一份并已分叉)。
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import type { Failure } from '@/lib/failure-of';
import { notify } from './notify';

/** `「打开失败」 <name>: <按 code 本地化的原因>`,toast 附 code。调用方已自行 console 记录时传 mirror:false。 */
export function notifyOpenFailed(
  name: string,
  failure: Failure,
  opts?: { readonly mirror: false },
): void {
  // 空串 message 同缺省(否则弹「打开失败 x: 」)。
  const reason = localizeErrorByCode(failure.code, failure.message || failure.code);
  notify.error(
    `${t('quick_open.open_failed')} ${name}: ${reason}`,
    opts ? { code: failure.code, mirror: false } : { code: failure.code },
  );
}
