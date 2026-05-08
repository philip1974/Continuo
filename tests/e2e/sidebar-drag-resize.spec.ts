// 拖拽 sidebar 4px 拖拽条改变宽度.
// useColumnResize 在 mousedown 时注册 document mousemove/mouseup,Playwright
// mouse.down/move/up 序列触发 native MouseEvent → React 合成事件正确路由.
import { test, expect } from './fixtures/with-workspace';

test('拖拽 4px 拖拽条向右 → sidebar width 增大 + StatusBar 视觉无变(纯 store)', async ({
  window,
}) => {
  const sidebar = window.locator('main aside').nth(1);
  await expect(sidebar).toBeVisible();
  // 初始 width 280
  const initial = await sidebar.evaluate((el: HTMLElement) => el.style.width);
  expect(initial).toBe('280px');

  const handle = sidebar.locator('.cursor-col-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle box null');

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  // 拖到右侧 60px(280 + 60 = 340)
  await window.mouse.move(startX, startY);
  await window.mouse.down();
  // 多步 mousemove 让 React 合成事件触发多次 onmousemove
  await window.mouse.move(startX + 30, startY, { steps: 5 });
  await window.mouse.move(startX + 60, startY, { steps: 5 });
  await window.mouse.up();

  // 等 react render
  await expect
    .poll(async () =>
      sidebar.evaluate((el: HTMLElement) => el.style.width),
    )
    .toBe('340px');
});
