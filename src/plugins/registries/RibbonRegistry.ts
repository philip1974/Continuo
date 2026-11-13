// IconSidebar 活动栏图标贡献(M-Plugin v2.1)。
// IconSidebar 在内置导航之下、settings 之上,订阅本 registry 动态渲染 NavRailButton。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { KeyedRegistry, snapshotByPriority } from './keyed-registry';
import { isSpecObject } from './spec-guard';

export interface RibbonActionSpec {
  readonly id: string;
  readonly title: string;        // NavRailButton tooltip + aria-label
  readonly icon: ReactNode;      // SVG / emoji / custom node
  readonly onClick: () => void | Promise<void>;
  readonly priority?: number;    // 升序排,默认 100
}


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

export class RibbonRegistry extends KeyedRegistry<RibbonActionSpec> {
  constructor() {
    super('ribbon-registry');
  }

  register(spec: RibbonActionSpec): Disposable {
    validateRibbonActionSpec(spec); // 边界(E49):注册前校验长度/priority finite/onClick 为函数
    return this.registerKeyed(spec.id, spec);
  }

  protected buildSnapshot(): readonly RibbonActionSpec[] {
    return snapshotByPriority(this.items);
  }
}
