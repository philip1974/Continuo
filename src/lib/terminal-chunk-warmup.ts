// Terminal lazy chunk 的"按意图预热"逻辑(打磨 R55)。从 main-app 抽出以便单测。
//
// 原先 main-app 在 idle 后无条件 import('@/panels/Terminal'),让从不开终端的 session
// 也下载/解析 6MB+ xterm chunk。改为只在**出现终端会话**(上次 session 恢复的终端,或
// 用户新建)时 warm 一次,与 React.lazy 的首开加载经模块缓存去重。

interface TerminalStoreLike {
  getState: () => { sessions: readonly unknown[] };
  subscribe: (listener: () => void) => () => void;
}

/**
 * 监听终端会话出现:sessions 从空变非空(恢复 / 新建)时调一次 onWarm。
 * 启动时若已有会话立即 warm。返回 unsubscribe(main-app 是应用根,通常不取消)。
 */
export function watchTerminalIntent(
  store: TerminalStoreLike,
  onWarm: () => void,
): () => void {
  let warmed = false;
  const check = (): void => {
    if (warmed) return;
    if (store.getState().sessions.length === 0) return;
    warmed = true;
    onWarm();
  };
  check();
  return store.subscribe(check);
}
