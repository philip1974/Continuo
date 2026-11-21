// Settings Panel 是 dockview panel 不是 Modal:Esc 不关闭.
import { test, expect } from './fixtures/electron-app';

const SETTINGS = /^(设置|Settings|설정)$/;
const SETTINGS_NAV = /^(设置分类|Setting categories|설정 카테고리)$/;

test('Settings panel 打开后,Esc 不关闭', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // Esc 不关 panel(panel 不是 Modal,没监听 Esc onClose)
  await window.keyboard.press('Escape');
  await window.waitForTimeout(300);
  await expect(nav).toBeVisible();
});
