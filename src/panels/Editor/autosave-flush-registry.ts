// topic 49 第十三轮 · P1-AE:关窗 / 退出立即 flush pending markdown autosave 的注册表。
//
// 镜像 explorer-persist 的 activeFlush 模式:每个 renderer 是独立 JS context,各窗只
// 持有/flush 自己活跃 tab 的 pending autosave。useAutoSave 把当前 scheduler 的
// flush 句柄注册进来,DockShell 关窗 flush 握手在 ack 前 await flushPendingAutoSave()。

let activeFlush: (() => Promise<void>) | null = null;
// 切走某 tab / 卸载时,useAutoSave 会 fire-and-forget 触发旧 tab scheduler 的 flush,
// 但 registry 的 activeFlush 已被新 tab 覆盖(或清空)→ 旧 tab 这次在途的落盘不在
// activeFlush 里。若此刻立即关窗,flush 握手只 await activeFlush,旧 tab 的写盘 IPC
// 仍在飞 → 主进程 ack 后继续退出,最后一段编辑静默丢失(codex 复审 F2)。
// 解法:把每个 fire-and-forget 的在途 flush 登记进来,关窗握手一并 await。
const inFlightFlushes = new Set<Promise<unknown>>();

/** useAutoSave 注册/注销当前活跃 tab 的立即落盘句柄。传 null 清空(卸载/无 tab)。 */
export function registerAutoSaveFlush(fn: (() => Promise<void>) | null): void {
  activeFlush = fn;
}

/**
 * 登记一个已启动但未完成的 flush(切走 tab / 卸载时旧 scheduler 的 fire-and-forget 落盘),
 * 使其纳入关窗 flush 握手的 await 链;settle 后自动移除,不泄漏。
 */
export function trackInFlightAutoSave(p: Promise<unknown>): void {
  inFlightFlushes.add(p);
  void Promise.resolve(p).finally(() => inFlightFlushes.delete(p));
}

/**
 * 立即 flush 待执行的 markdown autosave(绕过 2s 防抖)。供关窗 / 退出的 flush 握手
 * 在 ack 之前调用 —— 否则关窗前防抖窗口内的最后一段编辑随未触发的 timer 一起丢失。
 * 同时 await 所有已登记的在途 flush(切走 tab 后未完成的旧 tab 落盘)。
 * 未注册且无在途时 no-op。任一失败 swallow(各 scheduler 内部已记录),不阻断 ack。
 */
export async function flushPendingAutoSave(): Promise<void> {
  if (!activeFlush && inFlightFlushes.size === 0) return;
  if (activeFlush && inFlightFlushes.size === 0) {
    try {
      await activeFlush();
    } catch {
      /* scheduler 内部已记录;不阻断关窗 ack */
    }
    return;
  }
  const pending = new Array<Promise<unknown>>(
    inFlightFlushes.size + (activeFlush ? 1 : 0),
  );
  let i = 0;
  if (activeFlush) pending[i++] = activeFlush();
  for (const flush of inFlightFlushes) pending[i++] = flush;
  await Promise.allSettled(pending);
}
