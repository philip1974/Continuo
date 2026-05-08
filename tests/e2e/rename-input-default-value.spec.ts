// 右键 a.ts → 重命名 → input value 默认 'a.ts'.
import { test, expect } from './fixtures/with-workspace';

test('右键 a.ts → 重命名 → input value=a.ts', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^重命名/ }).click();

  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toHaveValue('a.ts');

  // ESC 取消
  await input.press('Escape');
});
