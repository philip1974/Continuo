// 点 file → row aria-selected='true'.
import { test, expect } from './fixtures/with-workspace';

test('点 README → aria-selected=true', async ({ window }) => {
  const row = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'README.md' })
    .first();
  await expect(row).toHaveAttribute('aria-selected', 'false');

  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true', {
    timeout: 3_000,
  });
});
