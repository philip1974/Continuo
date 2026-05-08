// 展开 src + 点 header「折叠全部」→ src 折叠 + a.ts 不显.
import { test, expect } from './fixtures/with-workspace';

test('展开 src → 折叠全部 → a.ts 隐', async ({ window }) => {
  // 展开 src
  await window.locator('text=src').first().click();
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toBeVisible({ timeout: 5_000 });

  // 点 header 「折叠全部」(hover 让 toolbar 浮现)
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();
  await aside.locator('button[aria-label="折叠全部"]').click();

  // a.ts 不再显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toHaveCount(0, { timeout: 5_000 });

  // src aria-expanded='false'
  const srcRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first();
  await expect(srcRow).toHaveAttribute('aria-expanded', 'false');
});
