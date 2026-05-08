// header「新建文件夹」 → ESC → 取消 + 无文件夹.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('header 新建文件夹 → ESC → 不创', async ({ window, workspaceRoot }) => {
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();

  await aside.locator('button[aria-label="新建文件夹"]').click();
  const input = window.locator('input[placeholder^="新建文件夹名"]');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill('cancelled-dir');
  await input.press('Escape');

  await expect(input).toBeHidden();
  const exists = await stat(path.join(workspaceRoot, 'cancelled-dir'))
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
});
