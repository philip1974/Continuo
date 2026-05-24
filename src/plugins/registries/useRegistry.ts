// 所有 *Registry 都有相同 shape:`getAll(): readonly T[]` + `subscribe(l) => () => void`。
// 抽公共 hook 消除 11+ 处 useState/useEffect/subscribe/getAll 重复。
//
// 简单用法:`const items = useRegistry(coApp.ribbon)`
// 参数化 getter:`useRegistry(coApp.statusBar, () => reg.getBySide(side), [side])`
//   — selector 闭包必须把外部依赖列进 deps,否则订阅回调 snapshot 会读到 stale 值。

import { useEffect, useState } from 'react';
import type React from 'react';

export interface RegistryLike<T> {
  getAll(): readonly T[];
  subscribe(listener: () => void): () => void;
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
