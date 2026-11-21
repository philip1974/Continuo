// 单击 file → row class 含 bg-hover(选中视觉)
import { test, expect } from './fixtures/with-workspace';

test('点 README.md → row 高亮(bg-hover)', async ({ window }) => {
  const row = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'README.md' })
    .first();
  await expect(row).toBeVisible();

  // 默认未选中
  const before = (await row.getAttribute('class')) ?? '';
  expect(before).not.toContain('bg-hover');

  await row.click();
  await expect(async () => {
    const after = (await row.getAttribute('class')) ?? '';
    expect(after).toContain('bg-hover');
  }).toPass({ timeout: 3_000 });
});
