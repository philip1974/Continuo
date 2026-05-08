// Settings Panel 是 dockview panel 不是 Modal:Esc 不关闭.
import { test, expect } from './fixtures/electron-app';

test('Settings panel 打开后,Esc 不关闭', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // Esc 不关 panel(panel 不是 Modal,没监听 Esc onClose)
  await window.keyboard.press('Escape');
  await window.waitForTimeout(300);
  await expect(nav).toBeVisible();
});
