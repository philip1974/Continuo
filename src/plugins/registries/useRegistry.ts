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

const NOOP_UNSUBSCRIBE = (): void => {};

export function useRegistry<T>(
  reg: RegistryLike<T>,
  selector?: () => readonly T[],
  deps: React.DependencyList = [],
): readonly T[] {
  const get = (): readonly T[] => (selector ? selector() : reg.getAll());
  const key: React.DependencyList = [reg, ...deps];
  const [state, setState] = useState<{ readonly key: React.DependencyList; readonly snap: readonly T[] }>(() => ({
    key,
    snap: get(),
  }));
  // deps(或 reg)变化:渲染期同步重算快照(React「根据上次渲染调整 state」:渲染期 setState 自身 state,React 丢弃本次输出
  // 立刻重渲,不提交中间帧)。此前只在 effect 里 setSnap → 先提交一帧「新 deps + 旧快照」(设置页切分类:导航已是「编辑器」、
  // 内容仍是「通用」的项,5–8ms)。
  let current = state;
  if (!depsEqual(state.key, key)) {
    current = { key, snap: get() };
    setState(current);
  }
  useEffect(() => {
    // 订阅建立前 registry 可能已变(渲染 → effect 之间):先补读一次;快照未变(同一引用)不触发重渲。
    const refresh = (): void => {
      const snap = get();
      setState((prev) => (prev.snap === snap ? prev : { key, snap }));
    };
    refresh();
    return reg.subscribe(refresh);
    // selector 由 caller 控制闭包稳定性;deps 显式声明
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, key);
  return current.snap;
}

function depsEqual(a: React.DependencyList, b: React.DependencyList): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * 多 source 联合 subscribe + 任一变化重算 selector(PluginsTabContent 6-registry 聚合)。
 * selector 只应读这些 source(不依赖其它会变的外部值)。
 */
export function useMultiRegistry<T>(
  sources: ReadonlyArray<SubscribableLike>,
  selector: () => T,
): T {
  const [snap, setSnap] = useState<T>(() => selector());
  useEffect(() => {
    const refresh = (): void => setSnap(selector());
    refresh();
    return subscribeAll(sources, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...sources]);
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
  if (sources.length === 0) return NOOP_UNSUBSCRIBE;
  if (sources.length === 1) return sources[0]!.subscribe(listener);

  const unsubs = new Array<() => void>(sources.length);
  for (let i = 0; i < sources.length; i++) {
    unsubs[i] = sources[i]!.subscribe(listener);
  }
  return () => {
    for (const u of unsubs) u();
  };
}
