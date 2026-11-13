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
 * 把回传给外部(IPC / JSON-RPC)的错误文本限幅:超长时截断并标注省略的字符数。safe-handle 与 MCP host
 * 两个出口共用(上限各自定义)。
 */
export function capErrorText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… (+${s.length - max})` : s;
}

/**
 * 抛出值(catch 的 unknown)的稳定错误码:IPC reject / main 抛出的 Error 带 `code`;没有则归为
 * `'EXCEPTION'`。renderer 各 catch 分支此前逐处手写 `(err as { code?: string })?.code ?? 'EXCEPTION'`。
 */
export function errorCodeOf(err: unknown): string {
  return (err as { code?: string } | null | undefined)?.code ?? 'EXCEPTION';
}

/**
 * 构造带稳定 `code` 的业务错误(与读端 errorCodeOf 配对):safeHandle 把 code 透传进 IpcResult,
 * renderer 再按 code 本地化。新代码统一用它,不再手写 `Object.assign(new Error(msg), { code })`。
 */
export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
