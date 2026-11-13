// Plugin 贡献的 StatusBar item 注册表(M-Plugin v1.5)。
// 默认 priority=100,按 priority 升序排;StatusBar 组件订阅渲染。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { KeyedRegistry, snapshotByPriority } from './keyed-registry';
import {
  SPEC_ID_MAX,
  assertOptionalFinitePriority,
  assertSpecFunction,
  assertSpecObject,
  assertSpecString,
} from './spec-guard';

export interface StatusBarItemSpec {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** 升序排序键,默认 100. */
  readonly priority?: number;
  readonly render: () => ReactNode;
}

const EMPTY_STATUS_BAR_SNAPSHOT: readonly StatusBarItemSpec[] = [];

// 边界(E50,E35/E36/E37/E40/E48/E49 兄弟 registry):register 接受插件 StatusBarItemSpec 无运行时
// 校验。id 无长度上限,side 可为非 'left'/'right',priority 可 NaN/Infinity,render 未确认是函数。畸形
// item 进全局排序;非法 side 变成不可见但常驻 Map 的脏条目(getBySide 永不命中),NaN priority 让排序
// 比较器失真,非函数 render 虽被渲染侧 try/catch 兜住但每次状态栏重渲反复告警/跳过。注册入口校验
// id 非空限长 + side 枚举 + priority finite + render 为函数,非法抛不入。

function statusBarPriority(item: StatusBarItemSpec): number {
  return item.priority ?? 100;
}

function mergeSortedStatusBarItems(
  left: readonly StatusBarItemSpec[],
  right: readonly StatusBarItemSpec[],
): readonly StatusBarItemSpec[] | null {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const merged = new Array<StatusBarItemSpec>(left.length + right.length);
  let li = 0;
  let ri = 0;
  let mi = 0;
  while (li < left.length && ri < right.length) {
    const l = left[li]!;
    const r = right[ri]!;
    const leftPriority = statusBarPriority(l);
    const rightPriority = statusBarPriority(r);
    if (leftPriority === rightPriority) return null;
    if (leftPriority < rightPriority) {
      merged[mi++] = l;
      li += 1;
    } else {
      merged[mi++] = r;
      ri += 1;
    }
  }
  while (li < left.length) {
    merged[mi++] = left[li]!;
    li += 1;
  }
  while (ri < right.length) {
    merged[mi++] = right[ri]!;
    ri += 1;
  }
  return merged;
}

function validateStatusBarItemSpec(spec: StatusBarItemSpec): void {
  const tag = 'statusbar-registry';
  assertSpecObject(tag, spec);
  assertSpecString(tag, 'id', spec.id, SPEC_ID_MAX);
  if (spec.side !== 'left' && spec.side !== 'right') {
    throw new Error("[statusbar-registry] side must be 'left' or 'right'");
  }
  assertOptionalFinitePriority(tag, spec.priority);
  assertSpecFunction(tag, 'render', spec.render);
}

export class StatusBarRegistry extends KeyedRegistry<StatusBarItemSpec> {
  private cachedLeft: readonly StatusBarItemSpec[] | null = null;
  private cachedRight: readonly StatusBarItemSpec[] | null = null;

  constructor() {
    super('statusbar-registry');
  }

  register(spec: StatusBarItemSpec): Disposable {
    validateStatusBarItemSpec(spec); // 边界(E50):注册前校验 id 长度/side 枚举/priority finite/render 为函数
    return this.registerKeyed(spec.id, spec);
  }

  getBySide(side: 'left' | 'right'): readonly StatusBarItemSpec[] {
    const cached = side === 'left' ? this.cachedLeft : this.cachedRight;
    if (cached !== null) return cached;
    const matched = snapshotByPriority(this.items, (item) => item.side === side);
    const items = matched.length === 0 ? EMPTY_STATUS_BAR_SNAPSHOT : matched;
    if (side === 'left') this.cachedLeft = items;
    else this.cachedRight = items;
    return items;
  }

  protected buildSnapshot(): readonly StatusBarItemSpec[] {
    // 两侧快照都已算过 → 归并(等优先级跨侧时无法保证注册序,返回 null 退回全量排序)。
    if (this.cachedLeft !== null && this.cachedRight !== null) {
      const merged = mergeSortedStatusBarItems(this.cachedLeft, this.cachedRight);
      if (merged !== null) return merged;
    }
    // 全部条目都在同一侧 → 该侧快照即全量。
    if (this.cachedLeft !== null && this.cachedLeft.length === this.items.size) {
      return this.cachedLeft;
    }
    if (this.cachedRight !== null && this.cachedRight.length === this.items.size) {
      return this.cachedRight;
    }
    return snapshotByPriority(this.items);
  }

  protected override onSnapshotInvalidated(): void {
    this.cachedLeft = null;
    this.cachedRight = null;
  }
}
