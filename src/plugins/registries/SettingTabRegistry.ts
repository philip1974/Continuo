// 设置标签贡献(M-Plugin v2.4)。
// SettingsModal 订阅本 registry 渲染左侧 tab 列表 + 右侧内容。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';

export interface SettingTabSpec {
  readonly id: string;
  readonly title: string;
  readonly render: () => ReactNode;
  readonly priority?: number;     // 升序,默认 100
}

type Listener = () => void;

export class SettingTabRegistry {
  private items = new Map<string, SettingTabSpec>();
  private listeners = new Set<Listener>();

  register(spec: SettingTabSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[setting-tab-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
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

  getAll(): readonly SettingTabSpec[] {
    return Array.from(this.items.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
