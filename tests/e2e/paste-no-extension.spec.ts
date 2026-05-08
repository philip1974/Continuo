// 无扩展名 file → paste 到同目录 → 'name copy'(无 ext).
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('LICENSE 无扩展名 → copy + paste 到 src → src/LICENSE + src/LICENSE copy', async ({
  window,
  workspaceRoot,
}) => {
  await writeFile(path.join(workspaceRoot, 'LICENSE'), 'MIT');
  await window.waitForTimeout(300);

  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^LICENSE$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^复制$/ }).click();

  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/LICENSE'));
  }).toPass({ timeout: 5_000 });

  // 再 paste → src/LICENSE copy(无 ext)
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^粘贴$/ }).click();

  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/LICENSE copy'));
  }).toPass({ timeout: 5_000 });
});
