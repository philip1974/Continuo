// 删除路径:右键「移到废纸篓」→ ConfirmDialog 确认 → 文件被删.
//
// 注:Continuo 走 shell.trashItem(系统废纸篓 API)。e2e 启的 Electron 真调
// 这个 API,文件确实被移走;cleanup 在 fixture afterEach rm -rf 临时 ws 目录。
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_TRASH } from './helpers/explorer';

test('右键 README.md → 移到废纸篓 → 直接执行(无 confirm dialog)', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  const trashItem = window.getByRole('menuitem', { name: EXPLORER_TRASH });
  await expect(trashItem).toBeVisible({ timeout: 5_000 });
  await trashItem.click();

  // 文件已不在原路径(废纸篓系统 API 是同步移走;e2e 容忍轻微延迟)
  await expect(async () => {
    const exists = await stat(path.join(workspaceRoot, 'README.md'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  }).toPass({ timeout: 5_000 });
});

test('右键文件夹 src → 「移到废纸篓」批量删', async ({
  window,
  workspaceRoot,
}) => {
  // 多写一个文件让 src 不为空(基底 fixture 已写 a.ts/b.ts)
  await writeFile(path.join(workspaceRoot, 'src/c.ts'), 'export const c = 3;');

  await window.locator('text=src').first().click({ button: 'right' });
  const trashItem = window.getByRole('menuitem', { name: EXPLORER_TRASH });
  await trashItem.click();

  await expect(async () => {
    const exists = await stat(path.join(workspaceRoot, 'src'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  }).toPass({ timeout: 5_000 });
});
