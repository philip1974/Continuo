// Settings panel × 关 → 齿轮 → 重开;3 次循环不抛.
import { test, expect } from './fixtures/electron-app';

test('Settings: 开 → ×关 → 再开 → ×关 → 再开 (3次)', async ({ window }) => {
  const gear = window.locator('button[title="设置"]');
  const closeBtn = window.locator('button[aria-label="Close Settings"]');
  const nav = window.locator('nav[aria-label="设置分类"]');

  for (let i = 0; i < 3; i++) {
    await gear.click();
    await expect(nav).toBeVisible({ timeout: 10_000 });

    await closeBtn.click();
    await window.waitForTimeout(400);
    await expect(nav).toBeHidden({ timeout: 5_000 });
  }
});
