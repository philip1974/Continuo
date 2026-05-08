// 删 src 目录 → 已打开的 src/a.ts tab(filePath 前缀匹配 src/)由 store.removePath
// 自动关闭.
import { test, expect } from './fixtures/with-workspace';

test('打开 src/a.ts → trash src 目录 → tab 自动关闭', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // 右键 src 目录(treeitem)→ 移到废纸篓
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /移到废纸篓/ }).click();

  // a.ts tab 自动关闭(editor.store.removePath 前缀匹配)→ EditorWelcome
  await expect(window.getByText('未打开文件').first()).toBeVisible({
    timeout: 5_000,
  });
});
