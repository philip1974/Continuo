// rename 到完全相同的名字 → noop,文件保持原样.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('rename a.ts → a.ts 同名 → noop + 内容不变', async ({
  window,
  workspaceRoot,
}) => {
  const before = await readFile(path.join(workspaceRoot, 'src/a.ts'), 'utf8');

  await window.locator('text=src').first().click();
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();

  const input = window.locator('input:focus');
  // 不变名字直接 Enter
  await input.press('Enter');

  // 等一段确认无错
  await window.waitForTimeout(300);
  // 文件仍存在 + 内容不变
  const after = await readFile(path.join(workspaceRoot, 'src/a.ts'), 'utf8');
  expect(after).toBe(before);
});
