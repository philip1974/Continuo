// Explorer 右键菜单 → 新建文件 / 新建文件夹.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('右键文件夹「src」→ 新建文件 → CreateInput 输入 + 提交', async ({
  window,
  workspaceRoot,
}) => {
  // 展开 src
  await window.locator('text=src').first().click();

  // 右键 src 行
  await window.locator('text=src').first().click({ button: 'right' });

  const newFileItem = window.getByRole('menuitem', { name: /^新建文件$/ });
  await expect(newFileItem).toBeVisible({ timeout: 5_000 });
  await newFileItem.click();

  // CreateInput 出现在 FolderTree 顶部 sticky 栏(单 input + 父目录提示「在: ${parentDir}」)
  const createInput = window.locator(
    'input[placeholder^="新建文件名"]',
  );
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

  const newDirItem = window.getByRole('menuitem', { name: /^新建文件夹$/ });
  await expect(newDirItem).toBeVisible({ timeout: 5_000 });
  await newDirItem.click();

  const input = window.locator('input[placeholder^="新建文件夹名"]');
  await expect(input).toBeVisible();
  await input.fill('newdir');
  await input.press('Enter');

  await expect(async () => {
    const s = await stat(path.join(workspaceRoot, 'src/newdir'));
    expect(s.isDirectory()).toBe(true);
  }).toPass({ timeout: 5_000 });
});
