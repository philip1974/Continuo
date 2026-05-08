// 代码文件:dirty 时「保存」按钮 enable;无脏 disabled.
import { test, expect } from './fixtures/with-workspace';

test('a.ts 默认 → 保存按钮 disabled;输入 → enable;Cmd+S 后 → 又 disabled', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();

  const main = window.locator('main');
  const saveBtn = main
    .locator('button')
    .filter({ hasText: /^保存$/ })
    .first();
  await expect(saveBtn).toBeDisabled();

  // 输入
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // dirty');

  // enable
  await expect(saveBtn).toBeEnabled();

  // Cmd+S
  await cm.press('ControlOrMeta+KeyS');

  // 等保存 + dirty 清
  await expect(saveBtn).toBeDisabled({ timeout: 5_000 });
});
