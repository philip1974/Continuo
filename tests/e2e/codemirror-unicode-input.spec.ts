// CodeMirror 输入 unicode(中文)→ 内容更新,dirty 圆点出现.
import { test, expect } from './fixtures/with-workspace';

test('在 a.ts 输入中文 → store 更新,dirty 圆点出现', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();

  // 输入中文(Playwright keyboard.type 支持 unicode)
  await window.keyboard.type('// 测试');

  // dirty
  await expect(
    window.locator('span[aria-label="未保存修改"]'),
  ).toBeVisible({ timeout: 5_000 });

  // CodeMirror 显示新内容
  await expect(cm).toContainText('测试');
});
