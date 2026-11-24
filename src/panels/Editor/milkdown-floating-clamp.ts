// Crepe 斜杠菜单(@milkdown/plugin-slash)只挂 flip + offset,没有 floating-ui 的 shift:光标靠右或窗口窄
// (如 640 宽)时菜单越出窗口右边被裁。工具条 / 链接气泡走 plugin-tooltip,已自带 shift。
// @floating-ui/dom 不是本项目直接依赖(pnpm 严格隔离下 renderer 解析不到),这里给一个只做水平夹回的
// 最小中间件,经 featureConfigs[BlockEdit].slashMenu.middleware 追加在 flip / offset 之后。

/** 与 CSS 兜底 `max-width: calc(100vw - 16px)` 对应的单侧留白。 */
export const FLOATING_VIEWPORT_PADDING = 8;

interface ClampState {
  readonly x: number;
  readonly rects: { readonly reference: { readonly x: number }; readonly floating: { readonly width: number } };
  readonly elements: { readonly reference: { getBoundingClientRect(): { readonly x: number } } };
}

/**
 * x 与 rects.* 同在 offsetParent 坐标系,reference.getBoundingClientRect() 是视口坐标 —— 两者之差即
 * offsetParent 坐标 → 视口坐标的平移量,据此把浮层视口左边夹到 [padding, innerWidth - padding - width];
 * 比视口还宽时贴左边 padding。
 */
export function clampFloatingToViewport(padding = FLOATING_VIEWPORT_PADDING) {
  return {
    name: 'continuoClampToViewport',
    fn(state: ClampState): { x: number } {
      const { x, rects, elements } = state;
      const left = elements.reference.getBoundingClientRect().x + (x - rects.reference.x);
      const maxLeft = window.innerWidth - padding - rects.floating.width;
      const target = Math.max(padding, Math.min(left, maxLeft));
      return { x: x + (target - left) };
    },
  };
}
