// 把 React.lazy 组件包装成 PanelSpec.factory / SettingTab.render 可直接传的函数。
// 自动挂 Suspense 边界,fallback 为 null(让 PanelMount 的进场动画接管首帧)。

import {
  Suspense,
  createElement,
  lazy,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

const EMPTY_LAZY_PANEL_PROPS: Record<string, never> = {};

export interface PreloadableLazy<C> {
  /** 面板组件:预取完成后挂载直接渲染已加载的组件;否则走 React.lazy 挂起。 */
  readonly Component: C;
  /** 预取模块(重复调用共用同一次加载;失败不缓存,下次重新 import)。与 Component 的 lazy 共用这一加载器 → 同一 chunk。 */
  readonly preload: () => Promise<unknown>;
}

/** 面板组件:预取完成后挂载直接渲染已加载的组件;否则走 React.lazy 挂起。 */
export function preloadableLazy<C extends ComponentType<never>>(
  load: () => Promise<{ default: C }>,
): PreloadableLazy<C> {
  // 内部按「接受任意 props 的组件」处理,对外保持调用方组件的类型(同 React.lazy 的 T extends ComponentType<any>)。
  type Loaded = ComponentType<object>;
  let loaded: Loaded | null = null;
  let pending: Promise<{ default: Loaded }> | null = null;
  const preload = (): Promise<{ default: Loaded }> => {
    pending ??= (load as unknown as () => Promise<{ default: Loaded }>)().then(
      (m) => {
        loaded = m.default;
        return m;
      },
      (err: unknown) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  };
  const Lazy = lazy(preload);
  function PreloadableComponent(props: object): ReactNode {
    const [Impl] = useState<Loaded>(() => loaded ?? Lazy);
    return createElement(Impl, props);
  }
  return { Component: PreloadableComponent as unknown as C, preload };
}

export function lazyPanel<P = unknown>(
  Lazy: ComponentType<P>,
): (props?: unknown) => ReactNode {
  return function LazyPanel(props?: unknown) {
    return createElement(
      Suspense,
      { fallback: null },
      createElement(
        Lazy as ComponentType<Record<string, never>>,
        (props ?? EMPTY_LAZY_PANEL_PROPS) as Record<string, never>,
      ),
    );
  };
}
