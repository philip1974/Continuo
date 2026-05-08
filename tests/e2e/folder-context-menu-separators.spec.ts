// folder context menu 应有 ≥ 1 个 separator(分组).
import { test, expect } from './fixtures/with-workspace';

test('右键 src → 菜单内 separator 元素 ≥ 1', async ({ window }) => {
  await window.locator('text=src').first().click({ button: 'right' });
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible({ timeout: 5_000 });

  // separator 是 div.my-1.h-px.bg-line
  const seps = menu.locator('.h-px.bg-line');
  expect(await seps.count()).toBeGreaterThan(0);
});
