// IconSidebar 容器宽度 48px(tailwind w-12 = 3rem = 48px).
import { test, expect } from './fixtures/electron-app';

test('IconSidebar 第一个 aside 容器宽 48px', async ({ window }) => {
  const aside = window.locator('aside').first();
  await expect(aside).toBeVisible({ timeout: 5_000 });

  const box = await aside.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(46);
  expect(box!.width).toBeLessThanOrEqual(50);
});
