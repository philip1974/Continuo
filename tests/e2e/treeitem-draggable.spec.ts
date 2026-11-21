// treeitem draggable='true'(headless-tree dragFeature).
import { test, expect } from './fixtures/with-workspace';

test('README.md row + src row 都 draggable=true', async ({ window }) => {
  const readmeRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'README.md' })
    .first();
  const srcRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first();

  await expect(readmeRow).toHaveAttribute('draggable', 'true');
  await expect(srcRow).toHaveAttribute('draggable', 'true');
});
