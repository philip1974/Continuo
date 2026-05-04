// Plugin 贡献的 StatusBar item 注册表(M-Plugin v1.5)。
// 默认 priority=100,按 priority 升序排;StatusBar 组件订阅渲染。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';

export interface StatusBarItemSpec {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** 升序排序键,默认 100. */
  readonly priority?: number;
  readonly render: () => ReactNode;
}

type Listener = () => void;

export class StatusBarRegistry {
  private items = new Map<string, StatusBarItemSpec>();
  private listeners = new Set<Listener>();

  register(spec: StatusBarItemSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[statusbar-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
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

  getBySide(side: 'left' | 'right'): readonly StatusBarItemSpec[] {
    return Array.from(this.items.values())
      .filter((x) => x.side === side)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
