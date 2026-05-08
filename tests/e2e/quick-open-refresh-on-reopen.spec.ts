// Cmd+P 关 + 写新文件 + 重开 → 列表含新文件.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('Cmd+P → ESC → 写 new.ts → 重开 → 含 new.ts', async ({
  window,
  workspaceRoot,
}) => {
  // 第一次:看到 a.ts
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    window.locator('.wm-modal-content input[placeholder*="搜索文件名"]'),
  ).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });
  await window.keyboard.press('Escape');

  // 写新文件
  await writeFile(path.join(workspaceRoot, 'new.ts'), 'export const n = 0;\n');

  // 重开
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input2 = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
  await expect(input2).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('new.ts', {
    timeout: 10_000,
  });
});
