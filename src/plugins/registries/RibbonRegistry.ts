// IconSidebar 活动栏图标贡献(M-Plugin v2.1)。
// IconSidebar 在内置导航之下、settings 之上,订阅本 registry 动态渲染 NavRailButton。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';

export interface RibbonActionSpec {
  readonly id: string;
  readonly title: string;        // NavRailButton tooltip + aria-label
  readonly icon: ReactNode;      // SVG / emoji / custom node
  readonly onClick: () => void | Promise<void>;
  readonly priority?: number;    // 升序排,默认 100
}

type Listener = () => void;

export class RibbonRegistry {
  private items = new Map<string, RibbonActionSpec>();
  private listeners = new Set<Listener>();

  register(spec: RibbonActionSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[ribbon-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
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

  getAll(): readonly RibbonActionSpec[] {
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
