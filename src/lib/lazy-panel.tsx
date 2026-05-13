// 把 React.lazy 组件包装成 PanelSpec.factory / SettingTab.render 可直接传的函数。
// 自动挂 Suspense 边界,fallback 默认 null(让 PanelMount 的进场动画接管首帧)。

import {
  Suspense,
  createElement,
  type ComponentType,
  type ReactNode,
} from 'react';

export function lazyPanel<P = unknown>(
  Lazy: ComponentType<P>,
  fallback: ReactNode = null,
): (props?: unknown) => ReactNode {
  return function LazyPanel(props?: unknown) {
    return createElement(
      Suspense,
      { fallback },
      createElement(
        Lazy as ComponentType<Record<string, never>>,
        (props ?? {}) as Record<string, never>,
      ),
    );
  };
}
