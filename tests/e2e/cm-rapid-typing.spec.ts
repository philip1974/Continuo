// CM 连输多字符 → 全部记录(IME 安全 + 编辑事件正确路由).  @edge
import { test, expect } from './fixtures/with-workspace';

test('快输 abcdef → CM 内容含 abcdef', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();

  await window.keyboard.type('abcdefghij', { delay: 0 });

  await expect(cm).toContainText('abcdefghij', { timeout: 5_000 });
});
