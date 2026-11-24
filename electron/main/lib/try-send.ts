// 向单个 webContents 投递 IPC 消息并报告成败(无 electron 依赖,便于注入测试)。
//
// race(R62/R63/R72/R73 族):isDestroyed() 检查后、send 前目标仍可能销毁(renderer reload / 关窗),send 同步抛
// "Object has been destroyed"。裸抛会中断调用方的清理序列(pending / timer 泄漏、后续 finalize 不执行)。此前 7 处
// 各手写「判 isDestroyed + try send + 失败返回 false」;投递失败需要收尾(清 pending、按拒绝结算、入队重投)的
// 调用方据返回值处理。

export interface SendTarget {
  send(channel: string, payload: unknown): void;
  isDestroyed?(): boolean;
}

/** 目标缺失 / 已销毁 / send 抛错 → false(不抛);否则 true。 */
export function trySend(
  target: SendTarget | null | undefined,
  channel: string,
  payload: unknown,
): boolean {
  if (!target || target.isDestroyed?.() === true) return false;
  try {
    target.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
