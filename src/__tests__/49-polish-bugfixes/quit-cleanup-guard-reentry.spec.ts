// topic 49 第十二 session · codex 复审 F1:before-quit 重入守卫。
//
// 根因:旧实现单个 `quitCleanupStarted` 布尔,首次置 true 后任何重入都直接 return 且不
// preventDefault。用户在清理(await termService.cleanupAll() 强杀 PTY)在途时再次 Cmd+Q /
// 外部再次 app.quit() → 第二次 before-quit 命中守卫直接放行 → Electron 继续退出,绕过仍在
// await 的 cleanupAll → 忽略 SIGINT/SIGTERM 的 agent 子进程被孤儿化(第十三轮 P1-AI 的兄弟缺口)。
//
// 修:守卫区分 started/finished。run=首次跑清理;block=清理在途的重入(继续 preventDefault);
// allow=清理已完成后内部 app.quit() 的重入(放行)。

import { describe, it, expect } from 'vitest';
import { makeQuitCleanupGuard } from '../../../electron/main/quit-cleanup-guard';

describe('topic49 codexF1 · before-quit 重入守卫', () => {
  it('首次 before-quit → run(跑清理)', () => {
    const g = makeQuitCleanupGuard();
    expect(g.onBeforeQuit()).toBe('run');
  });

  it('清理在途时用户/外部再次 quit → block(继续拦截,不放行)', () => {
    const g = makeQuitCleanupGuard();
    expect(g.onBeforeQuit()).toBe('run'); // 首次,开始清理
    // 清理尚未完成(未 markFinished)。第二、三次重入都必须 block。
    expect(g.onBeforeQuit()).toBe('block');
    expect(g.onBeforeQuit()).toBe('block');
  });

  it('清理完成后内部 app.quit() 的重入 → allow(放行退出)', () => {
    const g = makeQuitCleanupGuard();
    expect(g.onBeforeQuit()).toBe('run');
    g.markFinished(); // cleanupAll 跑完,即将内部 app.quit()
    expect(g.onBeforeQuit()).toBe('allow');
    // 已完成态稳定:后续重入仍 allow。
    expect(g.onBeforeQuit()).toBe('allow');
  });

  it('完整时序:run → (在途)block → finished → allow', () => {
    const g = makeQuitCleanupGuard();
    const trail: string[] = [];
    trail.push(g.onBeforeQuit()); // run
    trail.push(g.onBeforeQuit()); // block (用户在清理时又按 Cmd+Q)
    g.markFinished();
    trail.push(g.onBeforeQuit()); // allow (内部 app.quit() 重入)
    expect(trail).toEqual(['run', 'block', 'allow']);
  });
});
