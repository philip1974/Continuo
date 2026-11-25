// BDD:popout 恢复在途时不写残缺布局。dockview fromJSON 把 popout 组异步开窗(逐个间隔 + 等子窗 load)后才挂上;
// 在此之前 toJSON 既不在 grid 也不在 popoutGroups → 这时写盘(⌘Q / 关窗 flush、自动保存)会永久丢掉该 popout 与其面板。
// 布局快照写盘先等恢复落定(全部挂上 / 开窗失败 / 限时)。见同目录 README 第 2 条。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POPOUT_RESTORE_POLL_MS,
  POPOUT_RESTORE_SETTLE_MAX_MS,
  trackPopoutRestore,
  whenPopoutRestoreSettled,
} from '@/shell/dock/popout-restore-settle';

function fakeApi() {
  const groups: Array<{ api: { location: { type: string } } }> = [];
  const failListeners = new Set<() => void>();
  return {
    groups,
    onDidOpenPopoutWindowFail: (cb: () => void) => {
      failListeners.add(cb);
      return { dispose: () => failListeners.delete(cb) };
    },
    /** dockview addPopoutGroup 完成:该组 location 变为 popout。 */
    popoutAttached() {
      groups.push({ api: { location: { type: 'popout' } } });
    },
    popoutFailed() {
      for (const cb of failListeners) cb();
    },
    get failListenerCount() {
      return failListeners.size;
    },
  };
}

async function isSettled(p: Promise<void>): Promise<boolean> {
  let settled = false;
  void p.then(() => (settled = true));
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

describe('popout 恢复落定后才写布局快照', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('没有登记恢复 / 布局无 popout → 立即落定', async () => {
    const api = fakeApi();
    expect(await isSettled(whenPopoutRestoreSettled(api))).toBe(true);
    trackPopoutRestore(api, 0);
    expect(await isSettled(whenPopoutRestoreSettled(api))).toBe(true);
  });

  it('恢复 2 个 popout:全部挂上之前不落定,挂齐后落定', async () => {
    const api = fakeApi();
    trackPopoutRestore(api, 2);
    const settled = whenPopoutRestoreSettled(api);
    await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS * 3);
    expect(await isSettled(settled)).toBe(false);
    api.popoutAttached();
    await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS);
    expect(await isSettled(settled)).toBe(false);
    api.popoutAttached();
    await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS);
    expect(await isSettled(settled)).toBe(true);
    // 落定后不再挂监听 / 轮询
    expect(api.failListenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('开窗失败(dockview 已把组收回主窗)计入落定', async () => {
    const api = fakeApi();
    trackPopoutRestore(api, 2);
    const settled = whenPopoutRestoreSettled(api);
    api.popoutAttached();
    api.popoutFailed();
    await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS);
    expect(await isSettled(settled)).toBe(true);
  });

  it('迟迟挂不上 → 限时后落定(写盘不被无限期挡住,远小于 main 的关窗 flush 回执上限)', async () => {
    const api = fakeApi();
    trackPopoutRestore(api, 1);
    const settled = whenPopoutRestoreSettled(api);
    await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_SETTLE_MAX_MS - POPOUT_RESTORE_POLL_MS);
    expect(await isSettled(settled)).toBe(false);
    await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS);
    expect(await isSettled(settled)).toBe(true);
    expect(POPOUT_RESTORE_SETTLE_MAX_MS).toBeLessThan(10_000);
  });

  it('dispose(DockShell 卸载 / dockview 重建)→ 立即落定并停止轮询', async () => {
    const api = fakeApi();
    const tracking = trackPopoutRestore(api, 1);
    const settled = whenPopoutRestoreSettled(api);
    tracking.dispose();
    expect(await isSettled(settled)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(api.failListenerCount).toBe(0);
  });
});
