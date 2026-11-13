// 子进程强杀升级:SIGTERM,graceMs 后仍未退出则 SIGKILL(子进程吞掉 SIGTERM 时不至于一直挂着)。
// plugin-shell-stream 的强制清理 / 超时分支与 plugins.service 的 git 超时此前各手写一份。
//
// grace timer 必须 unref:否则触发后即便子进程已死,这个内层 timer 仍会把 event loop 多撑 graceMs,
// 关窗 / 退出时延迟退出(第七 session R3:unref 曾逐个兄弟 timer 补)。kill 抛错(进程已退出等)忽略。

interface Killable {
  kill(signal?: NodeJS.Signals | number): boolean;
}

export function killWithGrace(child: Killable, graceMs = 1000): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  const killGraceTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, graceMs);
  // 非 Node 计时器环境(测试里的 fake timers / jsdom)下 setTimeout 可能返回 number,故探测后再调。
  const timer = killGraceTimer as { unref?: () => void };
  if (typeof timer.unref === 'function') timer.unref();
}
