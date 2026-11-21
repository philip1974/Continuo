// topic 49 · P2-BD:更新成功后 reload 失败 → 不得复活已 dismiss 的更新条目。
//
// 根因(P2-BB 残留缺口):onUpdate 成功后先乐观 dismissUpdate(id),再 await mgr.reload(id)
// 把内存版本推进到新版,最后 refreshUpdates() 对账。旧实现把 reload 包在 try/catch、catch
// 仅 console.warn 后**继续** refreshUpdates():若 reload 抛错(生命周期锁竞争 / 激活异常 /
// 磁盘瞬时错),内存里 manifest.version 仍是旧版 → refresh 的 isNewerVersion 仍为真 → 把刚
// dismiss 的条目又加回 available(更新按钮 + IconSidebar 角标复活,滞留到下次手动刷新)。
//
// 修复:reconcileAfterUpdate 做 reload→refresh 的成功门控,reload 失败跳过 refresh。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { reconcileAfterUpdate } from '../../marketplace/reconcile-after-update';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('topic49 P2-BD · reconcileAfterUpdate reload→refresh 门控', () => {
  it('reload 成功 → refresh 被调用(正常对账推进新版)', async () => {
    const refresh = vi.fn();
    await reconcileAfterUpdate({ reload: () => Promise.resolve(), refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('reload 失败 → refresh 不被调用(保留乐观 dismiss,不复活条目)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refresh = vi.fn();

    await reconcileAfterUpdate({
      reload: () => Promise.reject(new Error('lifecycle lock busy')),
      refresh,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled(); // 失败被记录而非静默
  });

  it('reload 失败被吞,不向上抛(更新成功后的善后不应破坏调用方)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      reconcileAfterUpdate({
        reload: () => Promise.reject(new Error('boom')),
        refresh: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });
});
