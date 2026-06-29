// 代码文件:dirty 走 tab indicator + Cmd/Ctrl+S,不显示保存按钮.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_SAVE_LABEL,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
} from './helpers/editor';

test('a.ts 默认无保存按钮;输入 → dirty;Cmd+S 后 → dirty 清除', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);

  // 输入
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');

  // dirty 后仍不显示保存按钮,用 tab dirty indicator 表示.
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);

  // Cmd+S
  await cm.press('ControlOrMeta+KeyS');

  // 等保存 + dirty 清
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0, {
    timeout: 5_000,
  });
});
