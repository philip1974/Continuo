// Dockview header「More actions」 → 菜单选 Output → Output panel 添加.
import { test, expect } from './fixtures/electron-app';

test('More actions menu → 选 Output → 添加 panel + 显占位 log', async ({
  window,
}) => {
  const moreBtn = window.locator('button[aria-label="More actions"]');
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Output');

  await menu.getByRole('menuitem', { name: 'Output', exact: true }).click();
  await expect(menu).toBeHidden();

  await expect(window.locator('text=Continuo ready')).toBeVisible({
    timeout: 10_000,
  });
});
