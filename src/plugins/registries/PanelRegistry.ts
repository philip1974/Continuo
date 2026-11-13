// Plugin 贡献的 Dockview panel 类型注册表(M-Plugin v1.5)。
// 纯数据 + subscribable;真正接 Dockview 的桥在 DockShell 里订阅本 registry。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { KeyedRegistry } from './keyed-registry';
import { isSpecObject } from './spec-guard';

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
const PANEL_TYPE_MAX = 256;
const PANEL_TITLE_MAX = 512;
const PANEL_KEY_MAX = 256; // titleKey(i18n key)

function validatePanelSpec(spec: PanelSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[panel-registry] spec must be an object');
  }
  if (typeof spec.type !== 'string' || spec.type.length === 0) {
    throw new Error('[panel-registry] type must be a non-empty string');
  }
  if (spec.type.length > PANEL_TYPE_MAX) {
    throw new Error(
      `[panel-registry] type exceeds max length ${PANEL_TYPE_MAX}`,
    );
  }
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new Error('[panel-registry] title must be a non-empty string');
  }
  if (spec.title.length > PANEL_TITLE_MAX) {
    throw new Error(
      `[panel-registry] title exceeds max length ${PANEL_TITLE_MAX}`,
    );
  }
  if (spec.titleKey !== undefined) {
    // 边界(E153,E37 兄弟):titleKey 为可选 string,但来自未类型化 JS plugin,须先 typeof 守卫
    // 再做长度上限(否则 titleKey:123 经 `(123).length === undefined > max` 为 false 绕过校验)。
    if (typeof spec.titleKey !== 'string') {
      throw new Error('[panel-registry] titleKey must be a string');
    }
    if (spec.titleKey.length > PANEL_KEY_MAX) {
      throw new Error(
        `[panel-registry] titleKey exceeds max length ${PANEL_KEY_MAX}`,
      );
    }
  }
  if (typeof spec.factory !== 'function') {
    throw new Error('[panel-registry] factory must be a function');
  }
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
