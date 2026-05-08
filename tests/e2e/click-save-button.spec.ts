// 点击 EditorHeader 「保存」按钮 → 文件落盘 + dirty 清.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('a.ts 修改 → 点保存按钮 → 磁盘更新 + dirty 消失', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-content');
  await expect(cm).toBeVisible({ timeout: 10_000 });
  await cm.click();
  await window.keyboard.type(' // click-save');

  await expect(window.locator('span[aria-label="未保存修改"]')).toBeVisible();

  // 点 EditorHeader 保存按钮
  const saveBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^保存$/ })
    .first();
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  // 等磁盘 + dirty 清
  await expect(saveBtn).toBeDisabled({ timeout: 5_000 });
  await expect(window.locator('span[aria-label="未保存修改"]')).toBeHidden();
  await expect(async () => {
    const content = await readFile(
      path.join(workspaceRoot, 'src/a.ts'),
      'utf8',
    );
    expect(content).toContain('click-save');
  }).toPass({ timeout: 5_000 });
});
