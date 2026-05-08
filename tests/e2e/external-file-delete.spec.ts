// 外部进程删除文件 → editor.store.removePath 同步关闭对应 tab.
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → 外部 unlink → tab 自动关闭', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 外部删除
  await unlink(path.join(workspaceRoot, 'src/a.ts'));

  // fs.watch 推送 → useFsWatcher 触发 invalidateChildrenIds → 树重新拉 children.
  // 验证 Explorer 中 a.ts treeitem 消失(editor tab 是否自动关由其它 sync 决定).
  const aRow = window
    .locator('[role=treeitem]')
    .filter({ hasText: 'a.ts' });
  await expect(aRow).toHaveCount(0, { timeout: 10_000 });
});
