// TitleBar dirty 标记:打开文件 + 编辑 → 标题文本含 ' ●' 后缀.
import { test, expect } from './fixtures/with-workspace';

test('编辑 a.ts → TitleBar 文件名追加 ●', async ({ window, workspaceRoot }) => {
  void workspaceRoot;

  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');

  // 修改 → dirty
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');

  // TitleBar 是 main 顶部的 header(第一个 header).
  // basename(filePath) + ' ●' = 'a.ts ●'
  await expect(window.locator('header').first()).toContainText('a.ts ●', {
    timeout: 5_000,
  });
});
