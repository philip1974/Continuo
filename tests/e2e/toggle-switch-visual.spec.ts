// 设置页布尔开关用 design Switch(wm-switch):data-checked 跟随值,打开态轨道 / 滑块颜色区分可见
// (旧实现打开态 bg-accent 轨道 + bg-fg 滑块暗色仅 1.32:1)。键盘 Space 可切换。
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('显示行号 Switch: 默认打开 → 点击关闭 → Space 再打开,滑块与轨道颜色不同', async ({
  window,
}) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
    .click();

  const toggle = window.locator('button[role=switch]').first();
  await expect(toggle).toHaveClass(/\bwm-switch\b/);
  await expect(toggle).toHaveAttribute('data-checked', 'true');
  const colors = await toggle.evaluate((el) => ({
    track: getComputedStyle(el).backgroundColor,
    thumb: getComputedStyle(el.querySelector('.wm-switch__thumb')!).backgroundColor,
  }));
  expect(colors.thumb).not.toBe(colors.track);

  await toggle.click();
  await expect(toggle).toHaveAttribute('data-checked', 'false', { timeout: 3_000 });

  await toggle.focus();
  await window.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('data-checked', 'true', { timeout: 3_000 });
});
