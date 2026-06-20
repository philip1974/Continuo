// topic 49 第十二 session · codex 复审 F1:before-quit 重入守卫(纯状态机,可单测)。
//
// 退出清理(flush 各窗 + termService.cleanupAll() 强杀 PTY)必须在 app.quit() 前 await
// 完成。清理跑完后我们自己调 app.quit(),会重入 before-quit —— 那次应放行退出。
//
// 旧实现只有单个 `quitCleanupStarted` 布尔:首次置 true 后,**任何**重入(含用户在清理
// 在途时再次 Cmd+Q / 外部再次 app.quit())都直接 return 且**不** preventDefault → Electron
// 继续退出,绕过仍在 await 的 cleanupAll → 忽略 SIGINT/SIGTERM 的 agent 子进程被孤儿化。
//
// 修:区分 started / finished 两态:
//   - 首次(未 started)        → 'run'   :preventDefault + 跑清理,完成后 markFinished()+app.quit()
//   - 清理在途(started,未 finished)→ 'block' :preventDefault 拦截,等在途清理跑完由内部 quit 放行
//   - 清理已完成(finished)      → 'allow' :放行(这正是内部 app.quit() 的重入)

export type QuitCleanupAction = 'run' | 'block' | 'allow';

export interface QuitCleanupGuard {
  /** 每次 before-quit 调用一次,返回本次应如何处理。 */
  onBeforeQuit: () => QuitCleanupAction;
  /** 清理全部完成、即将调用内部 app.quit() 之前调用 —— 让随后的重入放行。 */
  markFinished: () => void;
}

export function makeQuitCleanupGuard(): QuitCleanupGuard {
  let started = false;
  let finished = false;
  return {
    onBeforeQuit() {
      if (finished) return 'allow';
      if (started) return 'block';
      started = true;
      return 'run';
    },
    markFinished() {
      finished = true;
    },
  };
}
