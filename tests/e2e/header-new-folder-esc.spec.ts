// header「新建文件夹」 → ESC → 取消 + 无文件夹.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_NEW_FOLDER,
  EXPLORER_NEW_FOLDER_PLACEHOLDER,
} from './helpers/explorer';

test('header 新建文件夹 → ESC → 不创', async ({ window, workspaceRoot }) => {
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();

  await aside.getByRole('button', { name: EXPLORER_NEW_FOLDER }).click();
  const input = window.getByRole('textbox', {
    name: EXPLORER_NEW_FOLDER_PLACEHOLDER,
  });
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill('cancelled-dir');
  await input.press('Escape');

  await expect(input).toBeHidden();
  const exists = await stat(path.join(workspaceRoot, 'cancelled-dir'))
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
});
