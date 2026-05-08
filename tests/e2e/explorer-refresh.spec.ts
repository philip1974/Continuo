// ExplorerHeader hover 工具条「刷新」按钮 → 触发 tree.invalidateChildrenIds(root)
// → re-fetch listDir → UI 反映外部变化(即使 fs.watch 没推).
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('点「刷新」 → Explorer 立即反映外部新文件', async ({
  window,
  workspaceRoot,
}) => {
  // 外部添加文件
  await writeFile(path.join(workspaceRoot, 'manual.md'), '# manual\n');

  // hover header 让工具条 group-hover 浮现
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();
  // 「刷新」按钮 aria-label='刷新'
  const refreshBtn = aside.locator('button[aria-label="刷新"]');
  await expect(refreshBtn).toBeVisible({ timeout: 5_000 });
  await refreshBtn.click();

  // manual.md 出现
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: 'manual.md' }),
  ).toBeVisible({ timeout: 5_000 });
});
