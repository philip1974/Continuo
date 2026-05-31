// Plugin 贡献的 Dockview panel 类型注册表(M-Plugin v1.5)。
// 纯数据 + subscribable;真正接 Dockview 的桥在 DockShell 里订阅本 registry。

import type { ReactNode } from 'react';
import type { Disposable } from '../types';

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

type Listener = () => void;

export class PanelRegistry {
  private items = new Map<string, PanelSpec>();
  private listeners = new Set<Listener>();

  register(spec: PanelSpec): Disposable {
    if (this.items.has(spec.type)) {
      console.warn(
        `[panel-registry] type "${spec.type}" 已注册,后注册赢覆盖前者`,
      );
    }
    this.items.set(spec.type, spec);
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        // 仅当当前注册的还是 spec 本身才删(防被后注册者顶替后误删)
        if (this.items.get(spec.type) === spec) {
          this.items.delete(spec.type);
          this.notify();
        }
      },
    };
  }

  getAll(): readonly PanelSpec[] {
    return Array.from(this.items.values());
  }

  list(): readonly PanelSpec[] {
    return this.getAll();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
