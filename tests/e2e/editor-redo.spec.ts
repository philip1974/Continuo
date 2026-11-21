// 编辑 a.ts → 输入 → Cmd+Z → Cmd+Shift+Z → 重做后内容回到 typed.
import { test, expect } from './fixtures/with-workspace';

test('a.ts: 输入 → Cmd+Z → Cmd+Shift+Z → 内容含 redo-me', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // redo-me');
  await expect(cm).toContainText('redo-me');

  // undo
  await cm.press('ControlOrMeta+KeyZ');
  await expect(cm).not.toContainText('redo-me', { timeout: 5_000 });

  // redo (Shift+Cmd+Z)
  await cm.press('ControlOrMeta+Shift+KeyZ');
  await expect(cm).toContainText('redo-me', { timeout: 5_000 });
});
