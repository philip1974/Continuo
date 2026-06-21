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
 * fire-and-forget 预取 Terminal 面板 lazy chunk(xterm 6MB+addons)。
 *
 * specifier 必须与 `TerminalPlugin` 的 `React.lazy(() => import(...))` **逐字符一致**
 * (`@/panels/Terminal/TerminalPanelView`),才能请求同一 chunk、经模块缓存去重 —— 否则
 * 预热没有提前量。`terminal-chunk-warmup.spec.ts` 有静态断言锁定两处 specifier 一致。
 *
 * 用途:① main-app 的 watchTerminalIntent 在终端会话出现时预热;② 用户明确新建终端的
 * 入口(createUserTerminal)在调 IPC 前调用,使 chunk 下载/解析与 main 的 terminal:create
 * + PTY spawn + shell 启动**并行**,缩短首个终端的可见加载延迟。只在用户 intent 出现时
 * 预热(保 R55:从不开终端的 session 不触碰大 chunk)。重复调用经模块缓存去重,无副作用;
 * 失败吞掉(用户真触发时 React.lazy 会再试)。
 */
export function preloadTerminalPanelChunk(): void {
  void import('@/panels/Terminal/TerminalPanelView').catch(() => {
    /* 用户真触发时 React.lazy 会再试 */
  });
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
