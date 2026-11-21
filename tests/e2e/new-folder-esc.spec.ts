// 新建文件夹 Esc 取消 → 不创建.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_NEW_FOLDER,
  EXPLORER_NEW_FOLDER_PLACEHOLDER,
} from './helpers/explorer';

test('右键 src → 新建文件夹 → Esc → 不创建', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_NEW_FOLDER }).click();

  const input = window.getByRole('textbox', {
    name: EXPLORER_NEW_FOLDER_PLACEHOLDER,
  });
  await expect(input).toBeVisible();
  await input.fill('shouldnotexist');
  await input.press('Escape');

  await expect(input).toBeHidden();

  const exists = await stat(
    path.join(workspaceRoot, 'src/shouldnotexist'),
  )
    .then(() => true)
    .catch(() => false);
  expect(exists).toBe(false);
});
