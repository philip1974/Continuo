// race(R46):向 main 推 window→root 映射须先等 workspace hydrate,再读最新 root 推送。否则
// fire-and-forget 的 initExplorerPersistence 完成前首帧 root=null 会被立即推给 main → hydrate 前
// MCP/agent 建终端(未传 cwd)从空 map 回退成全局终端/错误 cwd。
import { describe, it, expect, vi } from 'vitest';
import { notifyRootWhenHydrated } from '../../shell/notify-root-when-hydrated';

describe('race(R46) · notifyRootWhenHydrated', () => {
  it('hydrate 前不推送;hydrate 后推**最新** root(非首帧 null)', async () => {
    let resolveHydrate: () => void = () => {};
    const notifyRoot = vi.fn(async () => ({ ok: true }));
    let root: string | null = null; // 首帧 root=null
    const p = notifyRootWhenHydrated({
      waitHydrated: () => new Promise<void>((r) => { resolveHydrate = r; }),
      getRoot: () => root,
      notifyRoot,
      isCancelled: () => false,
    });
    await Promise.resolve();
    expect(notifyRoot).not.toHaveBeenCalled(); // hydrate 未完成 → 不推首帧 null

    root = '/real'; // hydrate 把 root 设为真值
    resolveHydrate();
    await p;
    expect(notifyRoot).toHaveBeenCalledTimes(1);
    expect(notifyRoot).toHaveBeenCalledWith('/real'); // 推最新,而非首帧 null
  });

  it('hydrate 后 root 仍为 null(无 workspace)→ 推 null(正常空态)', async () => {
    const notifyRoot = vi.fn(async () => ({ ok: true }));
    await notifyRootWhenHydrated({
      waitHydrated: () => Promise.resolve(),
      getRoot: () => null,
      notifyRoot,
      isCancelled: () => false,
    });
    expect(notifyRoot).toHaveBeenCalledWith(null);
  });

  it('hydrate 完成前被 cancel(effect cleanup / 卸载)→ 不推送', async () => {
    let resolveHydrate: () => void = () => {};
    const notifyRoot = vi.fn(async () => ({ ok: true }));
    let cancelled = false;
    const p = notifyRootWhenHydrated({
      waitHydrated: () => new Promise<void>((r) => { resolveHydrate = r; }),
      getRoot: () => '/real',
      notifyRoot,
      isCancelled: () => cancelled,
    });
    cancelled = true; // hydrate resolve 前被取代/卸载
    resolveHydrate();
    await p;
    expect(notifyRoot).not.toHaveBeenCalled();
  });

  it('已 hydrated(Promise 立即 resolve)→ 正常 root 变更无延迟推送', async () => {
    const notifyRoot = vi.fn(async () => ({ ok: true }));
    await notifyRootWhenHydrated({
      waitHydrated: () => Promise.resolve(),
      getRoot: () => '/proj',
      notifyRoot,
      isCancelled: () => false,
    });
    expect(notifyRoot).toHaveBeenCalledWith('/proj');
  });
});
