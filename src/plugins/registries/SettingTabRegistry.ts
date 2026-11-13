// 设置标签贡献(M-Plugin v2.4)。
// SettingsPanel(v5 Phase 5,VSCode 同款)订阅本 registry 渲染左侧 tab 列表 + 右侧内容。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { KeyedRegistry, snapshotByPriority } from './keyed-registry';
import {
  SPEC_ID_MAX,
  SPEC_TITLE_MAX,
  assertOptionalFinitePriority,
  assertOptionalSpecString,
  assertSpecFunction,
  assertSpecObject,
  assertSpecString,
} from './spec-guard';

export interface SettingTabSpec {
  readonly id: string;
  readonly title: string;
  readonly titleKey?: string;
  readonly render: () => ReactNode;
  /** 左侧 nav 项前显示的图标(可选). 推荐 16px size 的 SVG ReactNode. */
  readonly icon?: ReactNode;
  readonly priority?: number;     // 升序,默认 100
}

// 边界(E40,E35/E36/E37 兄弟 registry):register 接受插件 SettingTabSpec 无运行时校验。id/title/
// titleKey 无长度上限,priority 可为 NaN/Infinity,render 也未确认是函数。畸形 tab 一注册即进
// getAll().sort() + 左侧导航;若成为 active,SettingsPanel 直接调 active.render(),非函数/异常会让
// 整个 Settings 面板崩溃(P1)。注册入口校验长度 + priority finite + render 为函数,非法抛不入。

function validateSettingTabSpec(spec: SettingTabSpec): void {
  const tag = 'setting-tab-registry';
  assertSpecObject(tag, spec);
  assertSpecString(tag, 'id', spec.id, SPEC_ID_MAX);
  assertSpecString(tag, 'title', spec.title, SPEC_TITLE_MAX);
  assertOptionalSpecString(tag, 'titleKey', spec.titleKey, SPEC_ID_MAX);
  assertOptionalFinitePriority(tag, spec.priority);
  assertSpecFunction(tag, 'render', spec.render);
}


export class SettingTabRegistry extends KeyedRegistry<SettingTabSpec> {
  constructor() {
    super('setting-tab-registry');
  }

  register(spec: SettingTabSpec): Disposable {
    validateSettingTabSpec(spec); // 边界(E40):注册前校验长度/priority finite/render 为函数
    return this.registerKeyed(spec.id, spec);
  }

  protected buildSnapshot(): readonly SettingTabSpec[] {
    return snapshotByPriority(this.items);
  }
}
