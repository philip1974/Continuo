// 编辑 a.ts → 输入 → Cmd+Z → CodeMirror 撤销,dirty 圆点消失.
import { test, expect } from './fixtures/with-workspace';

test('a.ts: 输入 → Cmd+Z → 内容恢复 + dirty 圆点消失', async ({ window }) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // undo-me');

  // dirty 圆点应出现
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();

  // Cmd+Z(在 CodeMirror 上)
  await cm.press('ControlOrMeta+KeyZ');

  // CodeMirror 撤销后内容里不应再含 'undo-me'
  await expect(cm).not.toContainText('undo-me', { timeout: 5_000 });

  // 撤销到原始内容 → dirty 应清(editor.store updateContent 比对 originalContent)
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeHidden({
    timeout: 5_000,
  });
});
