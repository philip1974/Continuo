// 拖拽超过 max(500)→ width clamp 到 500.
import { test, expect } from './fixtures/with-workspace';

test('拖到 +500px → width clamp 到 500', async ({ window }) => {
  const sidebar = window.locator('main aside').nth(1);
  await expect(sidebar).toBeVisible();
  expect(
    await sidebar.evaluate((el: HTMLElement) => el.style.width),
  ).toBe('280px');

  const handle = sidebar.locator('.cursor-col-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle box null');

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await window.mouse.move(startX, startY);
  await window.mouse.down();
  // 拖右 500px(280+500=780,远超 max=500 → clamp 到 500)
  await window.mouse.move(startX + 500, startY, { steps: 10 });
  await window.mouse.up();

  await expect
    .poll(async () =>
      sidebar.evaluate((el: HTMLElement) => el.style.width),
    )
    .toBe('500px');
});

test('拖到 -200px → width clamp 到 200(min)', async ({ window }) => {
  const sidebar = window.locator('main aside').nth(1);
  const handle = sidebar.locator('.cursor-col-resize');
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle box null');

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await window.mouse.move(startX, startY);
  await window.mouse.down();
  // 拖左 200px(280-200=80 < min 200,clamp 到 200)
  await window.mouse.move(startX - 200, startY, { steps: 10 });
  await window.mouse.up();

  await expect
    .poll(async () =>
      sidebar.evaluate((el: HTMLElement) => el.style.width),
    )
    .toBe('200px');
});
