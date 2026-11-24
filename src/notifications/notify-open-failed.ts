// 用户主动打开文件失败的统一提示(Explorer 点击文件 / Quick Open 选中文件共用;此前两处各写一份并已分叉)。
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { errorCodeOf } from '@shared/error-message';
import { notify } from './notify';

export interface OpenFailure {
  readonly code: string;
  readonly message?: string;
}

/** 抛出值 → 失败描述:code 取 errorCodeOf(无则 EXCEPTION),message 仅 Error 类抛出值才有。 */
export function openFailureOf(err: unknown): OpenFailure {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string'
    ? { code: errorCodeOf(err), message }
    : { code: errorCodeOf(err) };
}

/** `「打开失败」 <name>: <按 code 本地化的原因>`,toast 附 code。调用方已自行 console 记录时传 mirror:false。 */
export function notifyOpenFailed(
  name: string,
  failure: OpenFailure,
  opts?: { readonly mirror: false },
): void {
  const reason = localizeErrorByCode(failure.code, failure.message ?? failure.code);
  notify.error(
    `${t('quick_open.open_failed')} ${name}: ${reason}`,
    opts ? { code: failure.code, mirror: false } : { code: failure.code },
  );
}
