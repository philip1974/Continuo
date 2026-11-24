// Settings nav 各 tab 行渲染 svg 图标(GeneralIcon / EditorIcon / ExplorerIcon 等).
import { test, expect } from './fixtures/electron-app';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('Settings nav 各 tab 按钮含 svg 图标', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  const nav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(nav).toBeVisible({ timeout: 10_000 });

  // nav 内的 button 都应含 svg(每个 tab 都有 icon)
  const buttons = nav.locator('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(2);

  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    const svgCount = await btn.locator('svg').count();
    expect(svgCount).toBeGreaterThan(0);
  }
});
