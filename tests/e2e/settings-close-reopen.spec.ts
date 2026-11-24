// Settings panel × 关 → 齿轮 → 重开;3 次循环不抛.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, CLOSE_SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('Settings: 开 → ×关 → 再开 → ×关 → 再开 (3次)', async ({ window }) => {
  const gear = window.getByRole('button', { name: SETTINGS });
  const closeBtn = window.getByRole('button', { name: CLOSE_SETTINGS });
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });

  for (let i = 0; i < 3; i++) {
    await gear.click();
    await expect(nav).toBeVisible({ timeout: 10_000 });

    await closeBtn.click();
    await window.waitForTimeout(400);
    await expect(nav).toBeHidden({ timeout: 5_000 });
  }
});
