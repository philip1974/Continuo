// 外部 rename src/a.ts → src/aa.ts → fs.watch 推送 → tree 反映新名.
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('外部 rename a.ts → aa.ts → tree 中 a.ts 消失 + aa.ts 出现', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await expect(window.locator('text=a.ts').first()).toBeVisible({
    timeout: 10_000,
  });

  await rename(
    path.join(workspaceRoot, 'src/a.ts'),
    path.join(workspaceRoot, 'src/aa.ts'),
  );

  // 新文件名出现
  await expect(window.locator('text=aa.ts').first()).toBeVisible({
    timeout: 10_000,
  });
  // 老文件名(精确匹配)不再有 treeitem
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toBeHidden();
});
