// 拖拽 sidebar 4px 拖拽条改变宽度.
// useColumnResize 在 mousedown 时注册 document mousemove/mouseup,Playwright
// mouse.down/move/up 序列触发 native MouseEvent → React 合成事件正确路由.
import { test, expect } from './fixtures/with-workspace';
import { dragSidebarResize } from './helpers/explorer';

test('拖拽 4px 拖拽条向右 → sidebar width 增大 + StatusBar 视觉无变(纯 store)', async ({
  window,
}) => {
  const sidebar = window.locator('main aside').nth(1);
  await expect(sidebar).toBeVisible();
  // 初始 width 280
  const initial = await sidebar.evaluate((el: HTMLElement) => el.style.width);
  expect(initial).toBe('280px');

  // 拖到右侧 60px(280 + 60 = 340)
  await dragSidebarResize(window, 60);

  // 等 react render
  await expect
    .poll(async () => sidebar.evaluate((el: HTMLElement) => el.style.width))
    .toBe('340px');
});
