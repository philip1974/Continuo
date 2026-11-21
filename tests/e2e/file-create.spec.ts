// Explorer 右键菜单 → 新建文件 / 新建文件夹.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import {
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FILE_PLACEHOLDER,
  EXPLORER_NEW_FOLDER,
  EXPLORER_NEW_FOLDER_PLACEHOLDER,
} from './helpers/explorer';

test('右键文件夹「src」→ 新建文件 → CreateInput 输入 + 提交', async ({
  window,
  workspaceRoot,
}) => {
  // 展开 src
  await window.locator('text=src').first().click();

  // 右键 src 行
  await window.locator('text=src').first().click({ button: 'right' });

  const newFileItem = window.getByRole('menuitem', {
    name: EXPLORER_NEW_FILE,
  });
  await expect(newFileItem).toBeVisible({ timeout: 5_000 });
  await newFileItem.click();

  // CreateInput 出现在 FolderTree 顶部 sticky 栏(单 input + 父目录提示「在: ${parentDir}」)
  const createInput = window.getByRole('textbox', {
    name: EXPLORER_NEW_FILE_PLACEHOLDER,
  });
  await expect(createInput).toBeVisible({ timeout: 5_000 });
  await createInput.fill('hello.ts');
  await createInput.press('Enter');

  // 文件落盘
  await expect(async () => {
    await stat(path.join(workspaceRoot, 'src/hello.ts'));
  }).toPass({ timeout: 5_000 });
});

test('右键文件夹「src」→ 「新建文件夹」 → 创建到 src/', async ({
  window,
  workspaceRoot,
}) => {
  // ContextMenu「新建文件夹」只在 isFolder || isBlank 时显示;
  // 右键文件 row 不会显该项(只显 cut/copy/rename/...)。
  await window.locator('text=src').first().click({ button: 'right' });

  const newDirItem = window.getByRole('menuitem', {
    name: EXPLORER_NEW_FOLDER,
  });
  await expect(newDirItem).toBeVisible({ timeout: 5_000 });
  await newDirItem.click();

  const input = window.getByRole('textbox', {
    name: EXPLORER_NEW_FOLDER_PLACEHOLDER,
  });
  await expect(input).toBeVisible();
  await input.fill('newdir');
  await input.press('Enter');

  await expect(async () => {
    const s = await stat(path.join(workspaceRoot, 'src/newdir'));
    expect(s.isDirectory()).toBe(true);
  }).toPass({ timeout: 5_000 });
});
