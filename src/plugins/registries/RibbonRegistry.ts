// IconSidebar 活动栏图标贡献(M-Plugin v2.1)。
// IconSidebar 在内置导航之下、settings 之上,订阅本 registry 动态渲染 NavRailButton。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { KeyedRegistry, snapshotByPriority } from './keyed-registry';
import {
  SPEC_ID_MAX,
  SPEC_TITLE_MAX,
  assertOptionalFinitePriority,
  assertSpecFunction,
  assertSpecObject,
  assertSpecString,
} from './spec-guard';

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

function validateRibbonActionSpec(spec: RibbonActionSpec): void {
  const tag = 'ribbon-registry';
  assertSpecObject(tag, spec);
  assertSpecString(tag, 'id', spec.id, SPEC_ID_MAX);
  assertSpecString(tag, 'title', spec.title, SPEC_TITLE_MAX);
  assertOptionalFinitePriority(tag, spec.priority);
  assertSpecFunction(tag, 'onClick', spec.onClick);
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
