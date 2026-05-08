// 右键单文件 trash → 对应 editor tab 自动关闭(removePath),其他 tab 保留.
import { test, expect } from './fixtures/with-workspace';

test('开 a.ts + b.ts → trash a.ts → a tab 关 + b 保留', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  // 右键 a.ts → 移到废纸篓
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /移到废纸篓/ }).click();

  // 等 store removePath 执行 → a.ts 关闭后只剩 b.ts → 单 tab 紧凑模式(无 tablist)
  // EditorHeader 显示 b.ts 文件名,a.ts 不再出现
  await expect(window.locator('header').first()).toContainText('b.ts', {
    timeout: 5_000,
  });
  await expect(window.locator('header').first()).not.toContainText('a.ts');
});
