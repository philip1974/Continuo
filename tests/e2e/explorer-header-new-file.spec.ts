// 点 ExplorerHeader 顶部「新建文件」IconButton → CreateInput 出现 → 提交落盘到根.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FILE_PLACEHOLDER,
} from './helpers/explorer';

test('header「新建文件」按钮 → 输入 root.txt → 落到根目录', async ({
  window,
  workspaceRoot,
}) => {
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();

  const newFileBtn = aside.getByRole('button', { name: EXPLORER_NEW_FILE });
  await expect(newFileBtn).toBeVisible({ timeout: 5_000 });
  await newFileBtn.click();

  const createInput = window.getByRole('textbox', {
    name: EXPLORER_NEW_FILE_PLACEHOLDER,
  });
  await expect(createInput).toBeVisible({ timeout: 5_000 });
  await createInput.fill('root.txt');
  await createInput.press('Enter');

  await expect(async () => {
    const s = await stat(path.join(workspaceRoot, 'root.txt'));
    expect(s.isFile()).toBe(true);
  }).toPass({ timeout: 5_000 });
});
