// 所有 *Registry 都有相同 shape:`getAll(): readonly T[]` + `subscribe(l) => () => void`。
// 抽公共 hook 消除 11+ 处 useState/useEffect/subscribe/getAll 重复。
//
// 简单用法:`const items = useRegistry(coApp.ribbon)`
// 参数化 getter:`useRegistry(coApp.statusBar, () => reg.getBySide(side), [side])`
//   — selector 闭包必须把外部依赖列进 deps,否则订阅回调 snapshot 会读到 stale 值。
// 多源订阅:`useMultiRegistry([coApp.panels, coApp.commands, ...], () => snapshot())`
//   — 任一 source 变化都触发 selector 重算。

import { useEffect, useState } from 'react';
import type React from 'react';

export interface SubscribableLike {
  subscribe(listener: () => void): () => void;
}

export interface RegistryLike<T> extends SubscribableLike {
  getAll(): readonly T[];
}

export function useRegistry<T>(
  reg: RegistryLike<T>,
  selector?: () => readonly T[],
  deps: React.DependencyList = [],
): readonly T[] {
  const [snap, setSnap] = useState<readonly T[]>(() =>
    selector ? selector() : reg.getAll(),
  );
  useEffect(() => {
    const get = (): readonly T[] => (selector ? selector() : reg.getAll());
    setSnap(get());
    return reg.subscribe(() => setSnap(get()));
    // selector 由 caller 控制闭包稳定性;deps 显式声明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg, ...deps]);
  return snap;
}

/**
 * 多 source 联合 subscribe + 任一变化重算 selector(PluginsTabContent 6-registry 聚合)。
 * selector 必须把外部 deps 列进 deps,与 useRegistry 一致。
 */
export function useMultiRegistry<T>(
  sources: ReadonlyArray<SubscribableLike>,
  selector: () => T,
  deps: React.DependencyList = [],
): T {
  const [snap, setSnap] = useState<T>(() => selector());
  useEffect(() => {
    const refresh = (): void => setSnap(selector());
    refresh();
    return subscribeAll(sources, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...sources, ...deps]);
  return snap;
}

/**
 * 非 React 场景的批量 subscribe(explorer-persist 在 module-level 用)。
 * 返回 unsubscribe-all。
 */
export function subscribeAll(
  sources: ReadonlyArray<SubscribableLike>,
  listener: () => void,
): () => void {
  const unsubs = new Array<() => void>(sources.length);
  for (let i = 0; i < sources.length; i++) {
    unsubs[i] = sources[i]!.subscribe(listener);
  }
  return () => {
    for (const u of unsubs) u();
  };
}
