// Settings activeTabId 在 panel 关闭后保留(决策 #2:close panel 不 reset).
import { test, expect } from './fixtures/electron-app';

test('切到「快捷键」tab → 关 Settings panel → 重开仍在「快捷键」', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await nav.getByRole('button', { name: '快捷键', exact: true }).click();
  // 验证当前 tab content 是 keybindings
  await expect(
    window.locator('text=/共\\s*\\d+\\s*个有快捷键的命令/'),
  ).toBeVisible();

  // 关 panel
  await window.locator('button[aria-label="Close Settings"]').click();
  await window.waitForTimeout(400);
  await expect(nav).toBeHidden();

  // 重开 — 应直接打开「快捷键」tab(activeTabId 保留)
  await window.locator('button[title="设置"]').click();
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await expect(
    window.locator('text=/共\\s*\\d+\\s*个有快捷键的命令/'),
  ).toBeVisible({ timeout: 5_000 });
});
