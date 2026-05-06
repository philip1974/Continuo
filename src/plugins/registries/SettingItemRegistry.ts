// 单个设置项贡献(M-Settings v6)。
// 与 SettingTabRegistry 同级,但粒度细到「一个 toggle / select」级别。
// plugin 用 Plugin.addSettingItem(spec) 注册,通用渲染器自动渲染 UI,
// 免每加一项偏好都写一整页 SettingTab。
//
// 内置「通用 / 编辑器」等 tab 自动消费 category 匹配的 items。

import type { Disposable } from '../types';

export type SettingItemType = 'boolean' | 'select' | 'number' | 'text';

export interface SettingItemEnumOption {
  readonly value: string;
  readonly label: string;
}

export type SettingItemValue = string | number | boolean;

export interface SettingItemSpec {
  /** 全局唯一,推荐 'category.name' 风格,如 'general.theme'. */
  readonly id: string;
  /** 归属 category(决定哪个 tab 渲染本项),如 'general' / 'editor'. */
  readonly category: string;
  /** 同 category 内的子分组(可选). 同 group 的 items 一起渲染,
   *  group header 显示在第一项之前. 缺失时归 default bucket(无 header). */
  readonly group?: string;
  readonly title: string;
  readonly description?: string;
  readonly type: SettingItemType;
  readonly default: SettingItemValue;
  /** type='select' 时必填. */
  readonly enum?: readonly SettingItemEnumOption[];
  /** type='number' 时可选(min/max/step 同 HTML number input). */
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** type='number' 时可选:右侧显示的单位 chip(如 'ms' / 'px'). */
  readonly unit?: string;
  /** 同 category 内升序排序,默认 100. */
  readonly priority?: number;
}

type Listener = () => void;

export class SettingItemRegistry {
  private items = new Map<string, SettingItemSpec>();
  private listeners = new Set<Listener>();

  register(spec: SettingItemSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[setting-item-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.items.set(spec.id, spec);
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.notify();
        }
      },
    };
  }

  getAll(): readonly SettingItemSpec[] {
    return Array.from(this.items.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }

  /** 取某 category 下的所有 items(已排序),供 CategoryTabContent 使用. */
  getByCategory(category: string): readonly SettingItemSpec[] {
    return this.getAll().filter((s) => s.category === category);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
