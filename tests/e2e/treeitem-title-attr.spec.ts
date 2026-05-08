// treeitem 的 title 属性 = 绝对路径.
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('README.md treeitem title=workspaceRoot/README.md', async ({
  window,
  workspaceRoot,
}) => {
  const row = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'README.md' })
    .first();
  await expect(row).toHaveAttribute(
    'title',
    path.join(workspaceRoot, 'README.md'),
  );
});
