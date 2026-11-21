// 外部新建文件 → fs.watch 推送 → Explorer 自动出现新文件.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('外部 writeFile 创建 src/new.ts → Explorer 出现新行', async ({
  window,
  workspaceRoot,
}) => {
  // 展开 src(useFsWatcher 监听已展开目录)
  await window.locator('text=src').first().click();
  await expect(window.locator('text=a.ts').first()).toBeVisible({
    timeout: 10_000,
  });

  // 外部创建文件
  await writeFile(
    path.join(workspaceRoot, 'src/new.ts'),
    'export const n = 0;\n',
  );

  // fs.watch 推送 + 100ms debounce + IPC 回拉 children
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: 'new.ts' }),
  ).toBeVisible({ timeout: 10_000 });
});
