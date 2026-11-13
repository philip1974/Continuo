// Plugin 贡献的 Dockview panel 类型注册表(M-Plugin v1.5)。
// 纯数据 + subscribable;真正接 Dockview 的桥在 DockShell 里订阅本 registry。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { KeyedRegistry } from './keyed-registry';
import {
  SPEC_ID_MAX,
  SPEC_TITLE_MAX,
  assertOptionalSpecString,
  assertSpecFunction,
  assertSpecObject,
  assertSpecString,
} from './spec-guard';

export interface PanelSpec {
  /** Dockview panel component 类型名,跨插件唯一. */
  readonly type: string;
  /** Render 函数,返 React 节点. */
  readonly factory: (props: unknown) => ReactNode;
  /** 用户可见标题(默认 tab title). */
  readonly title: string;
  /**
   * i18n key（topic-19）。Dockview addPanel 时塞进 panel.params，
   * useDockLocaleSync 在 locale 变化时遍历 panels 调 panel.api.setTitle(tWithFallback(titleKey, title))。
   */
  readonly titleKey?: string;
}

// 边界(E37,E35/E36 兄弟 registry):register 接受插件 PanelSpec 无运行时校验。type/title/titleKey
// 无长度/非空上限,factory 也未确认是函数。畸形插件可注册超长 type 污染 Dockview components map /
// panel id 路径,超长标题卡住 tab/title 同步;factory 非函数会在 DockShell 渲染 panel 时直接抛 →
// dock 面板渲染崩溃。注册入口校验长度/非空 + factory 为函数,非法抛可诊断错误、不入 registry。

function validatePanelSpec(spec: PanelSpec): void {
  const tag = 'panel-registry';
  assertSpecObject(tag, spec);
  assertSpecString(tag, 'type', spec.type, SPEC_ID_MAX);
  assertSpecString(tag, 'title', spec.title, SPEC_TITLE_MAX);
  assertOptionalSpecString(tag, 'titleKey', spec.titleKey, SPEC_ID_MAX);
  assertSpecFunction(tag, 'factory', spec.factory);
}


export class PanelRegistry extends KeyedRegistry<PanelSpec> {
  constructor() {
    super('panel-registry', 'type');
  }

  register(spec: PanelSpec): Disposable {
    validatePanelSpec(spec); // 边界(E37):注册前校验 type/title/titleKey 长度非空 + factory 为函数
    return this.registerKeyed(spec.type, spec);
  }

  protected buildSnapshot(): readonly PanelSpec[] {
    const out = new Array<PanelSpec>(this.items.size);
    let i = 0;
    for (const item of this.items.values()) out[i++] = item;
    return out;
  }

  list(): readonly PanelSpec[] {
    return this.getAll();
  }
}
