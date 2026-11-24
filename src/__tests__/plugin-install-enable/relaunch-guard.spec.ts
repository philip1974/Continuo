// 「立即重启」走与 ⌘Q 相同的退出流程:退出被中止(脏文件确认取消 / 保存失败)时重启请求作废。
import { describe, expect, it } from 'vitest';
import { makeQuitCleanupGuard } from '../../../electron/main/quit-cleanup-guard';

describe('退出守卫 · 重启请求', () => {
  it('默认不重启', () => {
    const g = makeQuitCleanupGuard();
    expect(g.onBeforeQuit()).toBe('run');
    g.markFinished();
    expect(g.relaunchRequested()).toBe(false);
  });

  it('requestRelaunch → 退出清理完成时 relaunchRequested=true', () => {
    const g = makeQuitCleanupGuard();
    g.requestRelaunch();
    expect(g.onBeforeQuit()).toBe('run');
    g.markFinished();
    expect(g.relaunchRequested()).toBe(true);
  });

  it('退出被中止(cancel)→ 重启请求作废:之后普通退出不重启', () => {
    const g = makeQuitCleanupGuard();
    g.requestRelaunch();
    expect(g.onBeforeQuit()).toBe('run');
    g.cancel(); // 用户在脏文件确认框点了取消
    expect(g.relaunchRequested()).toBe(false);
    expect(g.onBeforeQuit()).toBe('run'); // 之后用户 ⌘Q
    g.markFinished();
    expect(g.relaunchRequested()).toBe(false);
  });
});
