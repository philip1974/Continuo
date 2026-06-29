// 拖拽超过 max(500)→ width clamp 到 500.
import { test, expect } from './fixtures/with-workspace';
import { dragSidebarResize } from './helpers/explorer';

test('拖到 +500px → width clamp 到 500', async ({ window }) => {
  const sidebar = window.locator('main aside').nth(1);
  await expect(sidebar).toBeVisible();
  expect(await sidebar.evaluate((el: HTMLElement) => el.style.width)).toBe('280px');

  // 拖右 500px(280+500=780,远超 max=500 → clamp 到 500)
  await dragSidebarResize(window, 500);

  await expect
    .poll(async () => sidebar.evaluate((el: HTMLElement) => el.style.width))
    .toBe('500px');
});

test('拖到 -200px → width clamp 到 200(min)', async ({ window }) => {
  const sidebar = window.locator('main aside').nth(1);
  // 拖左 200px(280-200=80 < min 200,clamp 到 200)
  await dragSidebarResize(window, -200);

  await expect
    .poll(async () => sidebar.evaluate((el: HTMLElement) => el.style.width))
    .toBe('200px');
});
