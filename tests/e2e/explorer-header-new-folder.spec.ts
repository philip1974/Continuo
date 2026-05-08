// 点 ExplorerHeader「新建文件夹」IconButton → 输入 → mkdir 到 workspace 根.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('header「新建文件夹」按钮 → 输入 root-dir → 根目录 mkdir', async ({
  window,
  workspaceRoot,
}) => {
  const aside = window.locator('main aside').nth(1);
  await aside.locator('div.group').first().hover();

  const newFolderBtn = aside.locator('button[aria-label="新建文件夹"]');
  await expect(newFolderBtn).toBeVisible({ timeout: 5_000 });
  await newFolderBtn.click();

  const createInput = window.locator('input[placeholder^="新建文件夹名"]');
  await expect(createInput).toBeVisible({ timeout: 5_000 });
  await createInput.fill('root-dir');
  await createInput.press('Enter');

  await expect(async () => {
    const s = await stat(path.join(workspaceRoot, 'root-dir'));
    expect(s.isDirectory()).toBe(true);
  }).toPass({ timeout: 5_000 });
});
