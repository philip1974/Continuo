// 展开 src → src/a.ts treeitem aria-level=2.
import { test, expect } from './fixtures/with-workspace';

test('展开 src → a.ts aria-level=2; src 自身 aria-level=1', async ({
  window,
}) => {
  const srcRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first();
  await expect(srcRow).toHaveAttribute('aria-level', '1');

  await srcRow.click();
  const aRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first();
  await expect(aRow).toBeVisible({ timeout: 5_000 });
  await expect(aRow).toHaveAttribute('aria-level', '2');
});
