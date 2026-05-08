// folder aria-expanded:默认 false,点击 → true.
import { test, expect } from './fixtures/with-workspace';

test('src folder aria-expanded false → 点击 → true', async ({ window }) => {
  const srcRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first();
  await expect(srcRow).toHaveAttribute('aria-expanded', 'false');

  await srcRow.click();
  await expect(srcRow).toHaveAttribute('aria-expanded', 'true', {
    timeout: 3_000,
  });
});
