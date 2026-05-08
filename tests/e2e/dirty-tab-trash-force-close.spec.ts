// 改 a.ts dirty → 右键 trash → 文件被删 + tab 也被自动关闭(removePath 不询问 dirty).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('dirty a.ts → trash → tab 自动关 + 文件被删', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty-trash');
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();

  // 右键 a.ts → 移到废纸篓
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /移到废纸篓/ }).click();

  // tab 被关:header 不再显 a.ts
  await expect(window.locator('header').first()).not.toContainText('a.ts ●', {
    timeout: 5_000,
  });
  // 文件被删
  await expect(async () => {
    const exists = await stat(path.join(workspaceRoot, 'src/a.ts'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  }).toPass({ timeout: 5_000 });
});
