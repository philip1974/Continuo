// 同组切换 dock 面板时保持各面板内容的滚动位置(VSCode:同组切换编辑器 / 视图,回来时视口原样)。
// BDD: src/__tests__/dock-panel-switch-keep-view/
//
// dockview 默认 renderer 'onlyWhenVisible':切到同组别的面板时把本面板内容 DOM 从文档卸下(React 组件仍挂着),
// 重新激活时再插回 —— 元素脱离文档期间布局盒被销毁,插回后 scrollTop / scrollLeft 归零(CodeMirror、Milkdown、
// 设置页等所有原生滚动容器都一样)。卸下发生在 dockview 派发隐藏事件之前,隐藏时已读不到滚动值,故平时在面板根上
// 以捕获阶段记下各滚动容器最近一次的位置,重新可见时(dockview 插回 DOM 后同步派发)写回。
// 不改 renderer 为 'always':它对隐藏面板用 display:none,滚动位置同样丢失,且所有面板常驻布局。

export interface PanelVisibilitySource {
  readonly isVisible: boolean;
  onDidVisibilityChange(cb: (event: { readonly isVisible: boolean }) => void): { dispose(): void };
}

interface ScrollPosition {
  readonly top: number;
  readonly left: number;
}

/** 在面板内容根上记录滚动位置、重新可见时恢复;返回注销函数。 */
export function keepScrollWhileHidden(root: HTMLElement, api: PanelVisibilitySource): () => void {
  const positions = new Map<Element, ScrollPosition>();
  let visible = api.isVisible;
  const onScroll = (event: Event): void => {
    const el = event.target as Element | null;
    // 隐藏期间 / 已脱离文档的元素(卸下前排队、卸下后才派发的滚动事件)读到的是归零后的值,不记
    if (!visible || el === null || el.nodeType !== 1 || !el.isConnected) return;
    if (!positions.has(el)) {
      // 已不在面板里的元素(切 tab / 切模式后卸载的旧编辑器)不再持有
      for (const old of positions.keys()) if (!root.contains(old)) positions.delete(old);
    }
    positions.set(el, { top: el.scrollTop, left: el.scrollLeft });
  };
  root.addEventListener('scroll', onScroll, { capture: true, passive: true });
  const sub = api.onDidVisibilityChange(({ isVisible }) => {
    visible = isVisible;
    if (!isVisible) return;
    for (const [el, pos] of positions) {
      if (!root.contains(el)) {
        positions.delete(el);
        continue;
      }
      if (el.scrollTop !== pos.top) el.scrollTop = pos.top;
      if (el.scrollLeft !== pos.left) el.scrollLeft = pos.left;
    }
  });
  return () => {
    root.removeEventListener('scroll', onScroll, { capture: true });
    sub.dispose();
  };
}
