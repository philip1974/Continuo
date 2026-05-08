// .gitignore paste 到同目录 → '.gitignore copy'(dot 不算 ext).
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('copy .gitignore → paste 到 src → 出现 .gitignore copy', async ({
  window,
  workspaceRoot,
}) => {
  // 创建 + 等 fs.watch
  await writeFile(path.join(workspaceRoot, '.gitignore'), '*.log');
  await window.waitForTimeout(300);

  // 切 showHiddenFiles=true 让 tree 显
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: { setSettingValue: (id: string, v: boolean) => void };
      }
    ).__continuoTest;
    t.setSettingValue('explorer.showHiddenFiles', true);
  });

  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^\.gitignore$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/.gitignore'));
  }).toPass({ timeout: 5_000 });

  // 再 paste → '.gitignore copy'
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/.gitignore copy'));
  }).toPass({ timeout: 5_000 });
});
