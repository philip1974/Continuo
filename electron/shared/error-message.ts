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
