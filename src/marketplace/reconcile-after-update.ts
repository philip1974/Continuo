// topic 49 · P2-BD:更新成功后的 reload→refresh 对账,reload 失败时不得复活已 dismiss 的条目。
//
// 根因(P2-BB 残留缺口):onUpdate 成功后先乐观 dismissUpdate(id) 让更新按钮即时收起,
// 再 `await mgr.reload(id)` 把 renderer 内存版本推进到新版,最后 refreshUpdates() 对账。
// 但旧实现把 reload 包在 try/catch 里、catch 仅 console.warn 后**继续** refreshUpdates():
// 若 reload 抛错(per-id 生命周期锁竞争 / 激活异常 / 磁盘瞬时错),内存里 manifest.version
// 仍是旧版 → refresh 里 isNewerVersion 仍为真 → 把刚 dismiss 的条目又加回 available
// (更新按钮 + IconSidebar 角标复活并滞留到下次手动刷新)。
//
// 修复:仅当 reload 成功才 refresh;失败则保留乐观 dismiss 的结果,等 2s mtime watcher
// 自然 reload 后的下次刷新对账。

export interface ReconcileAfterUpdateOpts {
  /** 把 renderer 内存里的 PluginManager 版本推进到磁盘新版(per-id 生命周期锁). */
  reload: () => Promise<void>;
  /** 与远程清单对账,刷新 available 更新列表. */
  refresh: () => void;
}

/**
 * reload 成功后才 refresh;reload 失败跳过 refresh(保留乐观 dismiss,避免条目复活)。
 * reload 的异常被吞(仅 console.warn)——本对账是更新成功后的善后,不应再向上抛。
 */
export async function reconcileAfterUpdate(
  opts: ReconcileAfterUpdateOpts,
): Promise<void> {
  try {
    await opts.reload();
  } catch (err) {
    console.warn('[marketplace] reload after update failed', err);
    return; // 跳过 refresh:内存仍是旧版,refresh 会复活已 dismiss 的条目
  }
  opts.refresh();
}
