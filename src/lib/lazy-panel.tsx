// 把 React.lazy 组件包装成 PanelSpec.factory / SettingTab.render 可直接传的函数。
// 自动挂 Suspense 边界,fallback 为 null(让 PanelMount 的进场动画接管首帧)。

import {
  Suspense,
  createElement,
  type ComponentType,
  type ReactNode,
} from 'react';

const EMPTY_LAZY_PANEL_PROPS: Record<string, never> = {};

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
