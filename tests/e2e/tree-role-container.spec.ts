// FolderTree 容器 role=tree(headless-tree 自动).
import { test, expect } from './fixtures/with-workspace';

test('Explorer 内有 role=tree 容器', async ({ window }) => {
  const tree = window.locator('[role=tree]').first();
  await expect(tree).toBeVisible({ timeout: 10_000 });

  // tree 内含 ≥1 个 treeitem
  const items = tree.locator('[role=treeitem]');
  expect(await items.count()).toBeGreaterThan(0);
});
