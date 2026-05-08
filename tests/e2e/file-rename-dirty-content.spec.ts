// 修改 a.ts 内容(dirty)→ rename → 编辑器内容仍 dirty + tab 名变.
import { test, expect } from './fixtures/with-workspace';

test('dirty a.ts → rename → 内容 dirty 仍在 + tab 名变', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  // 输入 dirty
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty-rename');
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();

  // 右键 a.ts → 重命名
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^重命名/ }).click();

  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('renamed.ts');
  await input.press('Enter');

  // 等 rename 同步:editor.store.renamePath 改 tab.filePath → header 显新名
  await expect(window.locator('header').first()).toContainText('renamed.ts', {
    timeout: 5_000,
  });

  // 内容 dirty 仍在(rename 不影响 dirty 状态)
  await expect(cm).toContainText('dirty-rename');
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();
});
