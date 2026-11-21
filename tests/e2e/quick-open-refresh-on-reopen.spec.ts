// Cmd+P 关 + 写新文件 + 重开 → 列表含新文件.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

test('Cmd+P → ESC → 写 new.ts → 重开 → 含 new.ts', async ({
  window,
  workspaceRoot,
}) => {
  // 第一次:看到 a.ts
  await openQuickOpen(window);
  await expect(quickOpenInput(window)).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('a.ts', {
    timeout: 10_000,
  });
  await window.keyboard.press('Escape');

  // 写新文件
  await writeFile(path.join(workspaceRoot, 'new.ts'), 'export const n = 0;\n');

  // 重开
  await openQuickOpen(window);
  const input2 = quickOpenInput(window);
  await expect(input2).toBeVisible();
  await expect(window.locator('.wm-modal-content')).toContainText('new.ts', {
    timeout: 10_000,
  });
});
