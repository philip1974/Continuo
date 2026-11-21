// 重命名 Esc 取消(headless-tree renamingFeature 接管),磁盘文件不变.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('右键 → 重命名 → 输入新名 → Esc → 文件名不变', async ({
  window,
  workspaceRoot,
}) => {
  const before = await readFile(path.join(workspaceRoot, 'README.md'), 'utf8');

  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();

  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });

  await input.press('ControlOrMeta+KeyA');
  await input.fill('CHANGED.md');
  await input.press('Escape');

  // 旧文件仍在 + 内容未变
  const after = await readFile(path.join(workspaceRoot, 'README.md'), 'utf8');
  expect(after).toBe(before);

  // 新名字不存在
  const newExists = await stat(path.join(workspaceRoot, 'CHANGED.md'))
    .then(() => true)
    .catch(() => false);
  expect(newExists).toBe(false);
});
