// Settings activeTabId 在 panel 关闭后保留(决策 #2:close panel 不 reset).
import { test, expect } from './fixtures/electron-app';
import {
  CLOSE_SETTINGS,
  KEYBINDINGS_TAB,
  KEYBINDINGS_TOTAL_SUMMARY,
  SETTINGS,
  SETTINGS_NAV,
} from './helpers/settings';

test('切到「快捷键」tab → 关 Settings panel → 重开仍在「快捷键」', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  await nav.getByRole('button', { name: KEYBINDINGS_TAB }).click();
  // 验证当前 tab content 是 keybindings
  await expect(window.getByText(KEYBINDINGS_TOTAL_SUMMARY)).toBeVisible();

  // 关 panel
  await window.getByRole('button', { name: CLOSE_SETTINGS }).click();
  await window.waitForTimeout(400);
  await expect(nav).toBeHidden();

  // 重开 — 应直接打开「快捷键」tab(activeTabId 保留)
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await expect(window.getByText(KEYBINDINGS_TOTAL_SUMMARY)).toBeVisible({
    timeout: 5_000,
  });
});
