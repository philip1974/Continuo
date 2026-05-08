// 把 React.lazy 组件包装成 PanelSpec.factory / SettingTab.render 可直接传的函数。
// 自动挂 Suspense 边界,fallback 默认 null(让 PanelMount 的进场动画接管首帧)。

import {
  Suspense,
  createElement,
  type ComponentType,
  type ReactNode,
} from 'react';

export function lazyPanel(
  Lazy: ComponentType,
  fallback: ReactNode = null,
): () => ReactNode {
  return function LazyPanel() {
    return createElement(Suspense, { fallback }, createElement(Lazy));
  };
}
