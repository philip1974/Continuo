// CM Cmd+A 全选 + Backspace 删除 → 内容清空 + dirty.
import { test, expect } from './fixtures/with-workspace';

test('a.ts: Cmd+A → Backspace → 内容空 + dirty', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await expect(cm).toContainText('export const a = 1;');

  await cm.click();
  await cm.press('ControlOrMeta+KeyA');
  await cm.press('Backspace');

  // CM 内容不再含原始字符串
  await expect(cm).not.toContainText('export const a', { timeout: 5_000 });
  // dirty 出
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();
});
