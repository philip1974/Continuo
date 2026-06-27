// 设置标签贡献(M-Plugin v2.4)。
// SettingsPanel(v5 Phase 5,VSCode 同款)订阅本 registry 渲染左侧 tab 列表 + 右侧内容。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';
import { assertRegistryCapacity } from './registry-capacity';
import { isSpecObject } from './spec-guard';

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
const ST_ID_MAX = 256;
const ST_TITLE_MAX = 512;
const ST_KEY_MAX = 256; // titleKey(i18n key)

function validateSettingTabSpec(spec: SettingTabSpec): void {
  // 边界(E273,E271 registry 族):先校验 spec 是对象,否则读 spec.id/字段对 null/undefined 抛 TypeError。
  if (!isSpecObject(spec)) {
    throw new Error('[setting-tab-registry] spec must be an object');
  }
  if (typeof spec.id !== 'string' || spec.id.length === 0) {
    throw new Error('[setting-tab-registry] id must be a non-empty string');
  }
  if (spec.id.length > ST_ID_MAX) {
    throw new Error(`[setting-tab-registry] id exceeds max length ${ST_ID_MAX}`);
  }
  if (typeof spec.title !== 'string' || spec.title.length === 0) {
    throw new Error('[setting-tab-registry] title must be a non-empty string');
  }
  if (spec.title.length > ST_TITLE_MAX) {
    throw new Error(
      `[setting-tab-registry] title exceeds max length ${ST_TITLE_MAX}`,
    );
  }
  if (spec.titleKey !== undefined) {
    // 边界(E155,E153/E154 兄弟):可选 titleKey 来自未类型化 JS plugin,先 typeof 再长度
    // (否则 titleKey:123 经 `(123).length === undefined > max` 为 false 绕过)。
    if (typeof spec.titleKey !== 'string') {
      throw new Error('[setting-tab-registry] titleKey must be a string');
    }
    if (spec.titleKey.length > ST_KEY_MAX) {
      throw new Error(
        `[setting-tab-registry] titleKey exceeds max length ${ST_KEY_MAX}`,
      );
    }
  }
  if (spec.priority !== undefined && !Number.isFinite(spec.priority)) {
    throw new Error('[setting-tab-registry] priority must be finite');
  }
  if (typeof spec.render !== 'function') {
    throw new Error('[setting-tab-registry] render must be a function');
  }
}

type Listener = () => void;

export class SettingTabRegistry {
  private items = new Map<string, SettingTabSpec>();
  private listeners = new Set<Listener>();
  private cachedAll: readonly SettingTabSpec[] | null = null;

  register(spec: SettingTabSpec): Disposable {
    validateSettingTabSpec(spec); // 边界(E40):注册前校验长度/priority finite/render 为函数
    // 边界(E236):注册前容量守卫(共享 helper),超限抛、不入表
    assertRegistryCapacity('setting-tab-registry', this.items.size, this.items.has(spec.id));
    if (this.items.has(spec.id)) {
      console.warn(
        `[setting-tab-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
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

  getAll(): readonly SettingTabSpec[] {
    if (this.cachedAll !== null) return this.cachedAll;

    const items = new Array<SettingTabSpec>(this.items.size);
    let i = 0;
    for (const item of this.items.values()) items[i++] = item;
    if (items.length > 1) {
      items.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }
    this.cachedAll = items;
    return items;
  }

  /**
   * race(R55,R50-R54 同族):按 id 取当前 live setting tab(已 unregister 返 undefined)。
   * SettingsPanel 渲染时调 active.render();useRegistry 快照(useState 订阅模式)滞后 registry
   * 一帧,tab 刚 unregister 时快照仍含它 → 会执行已卸载 tab 的 render。渲染前用本方法按 id 从
   * live registry 复查,只调当前仍注册的 spec.render,已移除则回退。
   */
  get(id: string): SettingTabSpec | undefined {
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
