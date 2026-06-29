// 重命名:右键菜单 / F2 进入 RenameInput,改名 + Enter 提交.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('右键 README.md → 「重命名」 → 改名提交', async ({
  window,
  workspaceRoot,
}) => {
  // FolderTree 行
  const row = window.locator('text=README.md').first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // 右键打开 ContextMenu(Radix portal)
  await row.click({ button: 'right' });

  // 菜单项「重命名」(menuitem role)
  const renameItem = window.getByRole('menuitem', { name: EXPLORER_RENAME });
  await expect(renameItem).toBeVisible({ timeout: 5_000 });
  await renameItem.click();

  // headless-tree renamingFeature 把 row 文本变 input;直接定位活跃元素
  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });

  // 全选 + 输入新名字
  await input.press('ControlOrMeta+KeyA');
  await input.fill('READNEW.md');
  await input.press('Enter');

  // 等磁盘文件改名(rename 会触发 fs.watch 推送给 renderer,但磁盘已即时换)
  await expect(async () => {
    const files = await readFile(workspaceRoot, { encoding: 'utf8' }).catch(
      () => null,
    );
    void files;
    // 直接读目录里期望的新文件
    const newPath = path.join(workspaceRoot, 'READNEW.md');
    const txt = await readFile(newPath, 'utf8').catch(() => null);
    expect(txt).not.toBeNull();
  }).toPass({ timeout: 5_000 });
});
