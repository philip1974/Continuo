// 重命名一个已打开的文件 → editor tab 路径同步 + StatusBar / TitleBar 也同步.
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → 重命名为 renamed.ts → editor tab 同步新名', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  // 右键 Explorer 行(用 treeitem role 限定,避开 TitleBar/StatusBar 等同名文本)
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'a.ts' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^重命名/ }).click();

  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.press('ControlOrMeta+KeyA');
  await input.fill('renamed.ts');
  await input.press('Enter');

  // editor tab 文件名同步:TitleBar 显示新名
  await expect(window.locator('header').first()).toContainText('renamed.ts', {
    timeout: 5_000,
  });
  // StatusBar 也同步
  await expect(window.locator('footer')).toContainText('renamed.ts');
});
