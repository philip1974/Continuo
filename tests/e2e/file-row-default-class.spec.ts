// 未选中 file row 默认 class 含 text-fg-muted + hover:bg-panel-soft.
import { test, expect } from './fixtures/with-workspace';

test('未选中 README.md → class 含 text-fg-muted', async ({ window }) => {
  const row = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'README.md' })
    .first();
  await expect(row).toBeVisible();
  const cls = (await row.getAttribute('class')) ?? '';
  expect(cls).toContain('text-fg-muted');
  expect(cls).toContain('hover:bg-panel-soft');
});
