// File 模式 ContextMenu 至少 5 项内置:剪切/复制/重命名/复制路径/复制相对路径/移到废纸篓.
import { test, expect } from './fixtures/with-workspace';

test('右键 README.md → menuitem 数 ≥ 5', async ({ window }) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });

  const items = menu.getByRole('menuitem');
  expect(await items.count()).toBeGreaterThanOrEqual(5);

  // 关
  await window.keyboard.press('Escape');
});
