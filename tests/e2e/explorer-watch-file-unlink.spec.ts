// 外部 unlink → fs.watch 推送 → Explorer 中文件行消失.
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('外部 unlink src/a.ts → Explorer 中 a.ts 行消失', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  // 等 a.ts 出现
  await expect(window.locator('text=a.ts').first()).toBeVisible({
    timeout: 10_000,
  });

  await unlink(path.join(workspaceRoot, 'src/a.ts'));

  // 等 fs.watch 推 + 100ms debounce + IPC refresh
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toBeHidden({ timeout: 10_000 });

  // b.ts 还在
  await expect(window.locator('text=b.ts').first()).toBeVisible();
});
