// catch 分支的统一失败反馈(重构:renderer 十余处逐字复制「取 code → 按 code 本地化 → notify.error」)。
//
// a11y(A133-A151 族):fire-and-forget 的 async 事件处理器里,IPC reject 若无 catch 即 unhandled
// rejection 且用户得不到任何 toast / live region 反馈。各入口的 catch 统一走这里:
//   - code:抛出值的稳定错误码(无 → 'EXCEPTION'),随 toast 附带;
//   - 文案:按 `errors.<CODE>` catalog 本地化;未收录的 code 回退原 message;抛出值连 message 都
//     没有(非 Error)时回退 code 本身,不弹空 toast。

import { localizeErrorByCode } from '@/lib/localize-error';
import { notify } from './notify';
import { errorCodeOf } from '../../electron/shared/error-message';

export function notifyThrownError(err: unknown): void {
  const code = errorCodeOf(err);
  notify.error(localizeErrorByCode(code, (err as Error | null | undefined)?.message ?? code), {
    code,
  });
}

/**
 * `ok:false` 结果(IpcResult / ActionResult 的失败分支)的统一反馈:与 notifyThrownError 配对,
 * 按 code 本地化后 notify.error 并附 code。`message` 缺省回退 code。
 * `mirror:false` 仅当调用方已自行写过 console(见 notify.ts 的 mirror 语义)。
 */
export function notifyFailure(
  failure: { readonly code: string; readonly message?: string },
  opts?: { readonly mirror: false },
): void {
  const text = localizeErrorByCode(failure.code, failure.message ?? failure.code);
  notify.error(text, opts ? { code: failure.code, mirror: false } : { code: failure.code });
}
