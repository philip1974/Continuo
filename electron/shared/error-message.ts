// 把 unknown 形态的 catch error 收敛为可读 string,集中 14+ 处
// `err instanceof Error ? err.message : String(err)` 的重复表达。
//
// 放 shared 让 main / preload / renderer 都能 import 同一 helper。
//
// 用法:
//   notify.error(msg, { code, message: errorMessage(err) })
//   setMsg('✘ ' + errorMessage(err))

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 抛出值(catch 的 unknown)的稳定错误码:IPC reject / main 抛出的 Error 带 `code`;没有则归为
 * `'EXCEPTION'`。renderer 各 catch 分支此前逐处手写 `(err as { code?: string })?.code ?? 'EXCEPTION'`。
 */
export function errorCodeOf(err: unknown): string {
  return (err as { code?: string } | null | undefined)?.code ?? 'EXCEPTION';
}
