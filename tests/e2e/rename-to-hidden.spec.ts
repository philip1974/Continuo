// rename a.ts → .hidden.ts → showHiddenFiles=false 默认时 tree 不显新文件.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_RENAME } from './helpers/explorer';

test('rename a.ts → .hidden.ts → tree 不显', async ({ window, workspaceRoot }) => {
  await window.locator('text=src').first().click();
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_RENAME }).click();
  const input = window.locator('input:focus');
  await input.press('ControlOrMeta+KeyA');
  await input.fill('.hidden.ts');
  await input.press('Enter');

  // 改名确实落盘(否则下面「不显」区分不了被过滤与改名失败)
  await expect
    .poll(() => stat(path.join(workspaceRoot, 'src/.hidden.ts')).then(() => true, () => false), { timeout: 5_000 })
    .toBe(true);

  // a.ts 不再显
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^a\.ts$/ }),
  ).toHaveCount(0, { timeout: 5_000 });

  // .hidden.ts 也不显(被 showHiddenFiles=false 过滤)
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: /^\.hidden\.ts$/ }),
  ).toHaveCount(0);
});
