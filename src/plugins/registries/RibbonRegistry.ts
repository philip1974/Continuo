// IconSidebar 活动栏图标贡献(M-Plugin v2.1)。
// IconSidebar 在内置导航之下、settings 之上,订阅本 registry 动态渲染 NavRailButton。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';
import { isSpecObject } from './spec-guard';

export interface RibbonActionSpec {
  readonly id: string;
  readonly title: string;        // NavRailButton tooltip + aria-label
  readonly icon: ReactNode;      // SVG / emoji / custom node
  readonly onClick: () => void | Promise<void>;
  readonly priority?: number;    // 升序排,默认 100
}

type Listener = () => void;
const EMPTY_RIBBON_SNAPSHOT: readonly RibbonActionSpec[] = [];

// 边界(E49,E35/E36/E37/E40/E48 兄弟 registry):register 接受插件 RibbonActionSpec 无运行时校验。
// id/title 无长度上限,priority 可 NaN/Infinity,onClick 也未确认是函数。畸形项一注册即进 Activity
// Bar 排序+渲染;超长 title 污染 NavRailButton tooltip/aria-label,NaN priority 让排序比较器失真,
// 非函数 onClick 点击时才抛错。注册入口校验长度 + priority finite + onClick 为函数,非法抛不入。
const RB_ID_MAX = 256;
const RB_TITLE_MAX = 512;

function validateRibbonActionSpec(spec: RibbonActionSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[ribbon-registry] spec must be an object');
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new Error('[ribbon-registry] id must be a non-empty string');
  }
  if (spec.id.length > RB_ID_MAX) {
    throw new Error(`[ribbon-registry] id exceeds max length ${RB_ID_MAX}`);
  }
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new Error('[ribbon-registry] title must be a non-empty string');
  }
  if (spec.title.length > RB_TITLE_MAX) {
    throw new Error(
      `[ribbon-registry] title exceeds max length ${RB_TITLE_MAX}`,
    );
  }
  if (spec.priority !== undefined && !Number.isFinite(spec.priority)) {
    throw new Error('[ribbon-registry] priority must be finite');
  }
  if (typeof spec.onClick !== 'function') {
    throw new Error('[ribbon-registry] onClick must be a function');
  }
}

export class RibbonRegistry {
  private items = new Map<string, RibbonActionSpec>();
  private listeners = new Set<Listener>();
  private cachedAll: readonly RibbonActionSpec[] | null = null;

  register(spec: RibbonActionSpec): Disposable {
    validateRibbonActionSpec(spec); // 边界(E49):注册前校验长度/priority finite/onClick 为函数
    // 边界(E236):注册前容量守卫(共享 helper),超限抛、不入表
    assertRegistryCapacity('ribbon-registry', this.items.size, this.items.has(spec.id));
    if (this.items.has(spec.id)) {
      console.warn(
        `[ribbon-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.items.set(spec.id, spec);
    this.invalidateSnapshotCache();
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.invalidateSnapshotCache();
          this.notify();
        }
      },
    };
  }

  getAll(): readonly RibbonActionSpec[] {
    if (this.cachedAll !== null) return this.cachedAll;
    if (this.items.size === 0) {
      this.cachedAll = EMPTY_RIBBON_SNAPSHOT;
      return EMPTY_RIBBON_SNAPSHOT;
    }

    const items = new Array<RibbonActionSpec>(this.items.size);
    let i = 0;
    let prevPriority = -Infinity;
    let sorted = true;
    for (const item of this.items.values()) {
      const priority = item.priority ?? 100;
      if (priority < prevPriority) sorted = false;
      prevPriority = priority;
      items[i++] = item;
    }
    if (items.length > 1 && !sorted) {
      items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
    this.cachedAll = items;
    return items;
  }

  /**
   * race(R52,R51 同族):按 id 取当前 live ribbon action(已 unregister 返 undefined)。NavRailButton
   * 的 onClick 捕获了 RibbonActionSpec,插件 disable/reload 同步 unregister 后、到 React 重渲移除
   * 按钮前,旧 DOM handler 仍可触发 → click 时用本方法从 registry 重查再执行,死 action 静默忽略。
   */
  get(id: string): RibbonActionSpec | undefined {
    return this.items.get(id);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private invalidateSnapshotCache(): void {
    this.cachedAll = null;
  }
}
