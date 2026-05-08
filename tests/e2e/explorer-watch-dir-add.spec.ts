// 外部新建子目录 → fs.watch 推送 → Explorer 出现新目录 row.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('外部 mkdir src/newdir → Explorer 出现新目录', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await expect(window.locator('text=a.ts').first()).toBeVisible({
    timeout: 10_000,
  });

  await mkdir(path.join(workspaceRoot, 'src/newdir'));

  await expect(
    window.locator('[role=treeitem]').filter({ hasText: 'newdir' }),
  ).toBeVisible({ timeout: 10_000 });
});
