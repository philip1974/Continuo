// Dockview header「打开视图…」 → 菜单选 Output → Output panel 添加.
import { test, expect } from './fixtures/electron-app';
import { OUTPUT_PANEL, OUTPUT_EMPTY } from './helpers/output';
import { DOCK_OPEN_VIEW } from './helpers/explorer';

test('打开视图… 菜单 → 选 Output → 添加 panel + 显占位 log', async ({
  window,
}) => {
  const moreBtn = window
    .getByRole('button', { name: DOCK_OPEN_VIEW })
    .last();
  await expect(moreBtn).toBeVisible({ timeout: 10_000 });
  await moreBtn.click();

  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: OUTPUT_PANEL })).toBeVisible();

  await menu.getByRole('menuitem', { name: OUTPUT_PANEL }).click();
  await expect(menu).toBeHidden();

  await expect(window.getByText(OUTPUT_EMPTY)).toBeVisible({
    timeout: 10_000,
  });
});
