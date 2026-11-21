// rename 后,新名仍可右键操作.
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME, EXPLORER_TRASH } from './helpers/explorer';

test('rename a.ts → renamed.ts → 右键 renamed.ts → 菜单显', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();

  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('renamed.ts');
  await input.press('Enter');

  // 等 renamed.ts 出现
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^renamed\.ts$/ }),
  ).toBeVisible({ timeout: 5_000 });

  // 右键新名 → 菜单
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^renamed\.ts$/ })
    .first()
    .click({ button: 'right' });
  const menu = window.getByRole('menu').last();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(EXPLORER_TRASH);
  await expect(menu).toContainText(EXPLORER_RENAME);
});
