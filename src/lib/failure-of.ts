// catch 到的任意值 → 结构化失败描述(此前 6 处各写一份,回退规则分叉:有的回退 String(err)「[object Object]」、
// 有的回退空串 → 空 toast)。
import { errorCodeOf } from '@shared/error-message';

export interface Failure {
  readonly code: string;
  readonly message?: string;
}

/** code 取 errorCodeOf(无则 EXCEPTION);message 仅当抛出值带非空字符串 message 时才有(调用方缺省回退 code)。 */
export function failureOf(err: unknown): Failure {
  const message = (err as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.length > 0
    ? { code: errorCodeOf(err), message }
    : { code: errorCodeOf(err) };
}
