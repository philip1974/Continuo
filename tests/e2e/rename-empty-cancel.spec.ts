// rename 输入框 Enter 空字符串 → 取消 rename + 文件名不变.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('右键 → 重命名 → 全删 + Enter → 文件名不变', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();

  const input = window.locator('input:focus');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.press('ControlOrMeta+KeyA');
  await input.fill('');
  await input.press('Enter');
  await new Promise((r) => setTimeout(r, 500)); // 等 500ms 再复核磁盘

  // README.md 仍存在,且根目录没有多出别名文件
  const stat1 = await stat(path.join(workspaceRoot, 'README.md'))
    .then(() => true)
    .catch(() => false);
  expect(stat1).toBe(true);
  expect((await readdir(workspaceRoot)).sort()).toEqual(['README.md', 'src']);
});
