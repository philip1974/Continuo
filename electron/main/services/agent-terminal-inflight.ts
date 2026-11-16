/**
 * 在途 agent 终端创建(terminal.create_session)登记。
 *
 * 撤销授权 / 终端专属 token 吊销只回收已登记会话;授权通过后、PTY 尚未登记(installStopHook、spawn
 * 期间)的创建随后照常登记并跑 autorun。按调用方身份(ctx.callerSubject)登记在途创建,吊销时取消,
 * 创建流程在各异步边界后据取消信号自行回收(同 debug.service 在途 launch 登记)。
 */

const inFlight = new Map<string, Set<AbortController>>();

/** 登记一次在途创建;结束(无论成败)须调 done() 注销。 */
export function trackAgentTerminalCreate(callerSubject: string | null | undefined): {
  readonly signal: AbortSignal;
  readonly done: () => void;
} {
  const key = callerSubject ?? '';
  const controller = new AbortController();
  let set = inFlight.get(key);
  if (!set) {
    set = new Set();
    inFlight.set(key, set);
  }
  set.add(controller);
  return {
    signal: controller.signal,
    done: () => {
      const cur = inFlight.get(key);
      if (!cur) return;
      cur.delete(controller);
      if (cur.size === 0) inFlight.delete(key);
    },
  };
}

/** 取消该调用方的在途创建;省略 callerSubject 取消全部(撤销授权终止全部 agent 终端)。 */
export function cancelAgentTerminalCreates(callerSubject?: string): void {
  const keys = callerSubject === undefined ? [...inFlight.keys()] : [callerSubject];
  for (const key of keys) {
    const set = inFlight.get(key);
    if (!set) continue;
    inFlight.delete(key);
    for (const controller of set) controller.abort();
  }
}
