// StatusBar footer 高度 24px(h-6 = 1.5rem).
import { test, expect } from './fixtures/electron-app';

test('footer 高度近 24px', async ({ window }) => {
  const footer = window.locator('footer');
  await expect(footer).toBeVisible({ timeout: 5_000 });
  const box = await footer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(22);
  expect(box!.height).toBeLessThanOrEqual(26);
});
