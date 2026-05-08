// non-dirty tab 外部 writeFile → fs.watch 推 → reloadFromDisk → CM 自动同步.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts (non-dirty) → 外部 writeFile 新内容 → CM 自动同步', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  // 默认内容
  await expect(cm).toContainText('export const a = 1;');

  // 外部 writeFile 新内容
  await writeFile(
    path.join(workspaceRoot, 'src/a.ts'),
    'export const a = 99; // changed externally\n',
  );

  // 等 fs.watch 推 + reloadFromDisk → CM 显新内容
  await expect(cm).toContainText('changed externally', { timeout: 10_000 });
  await expect(cm).toContainText('99');

  // dirty 不应被触发(reloadFromDisk 不算 dirty)
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeHidden();
});
