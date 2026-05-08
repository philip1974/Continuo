// trash src/ → 内部所有 tab 一并关闭(removePath 前缀匹配).
import { test, expect } from './fixtures/with-workspace';

test('开 src/a.ts + src/b.ts → trash src → 两 tabs 都关 + EditorWelcome', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();

  // 2 tabs 模式
  await expect(window.locator('main [role=tablist]').first()).toBeVisible();
  const items = window
    .locator('main [role=tablist]')
    .first()
    .locator('div.wm-tab-nav-item');
  await expect(items).toHaveCount(2);

  // trash src
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /移到废纸篓/ }).click();

  // 两 tabs 都关 → EditorWelcome
  await expect(window.getByText('未打开文件').first()).toBeVisible({
    timeout: 5_000,
  });
});
