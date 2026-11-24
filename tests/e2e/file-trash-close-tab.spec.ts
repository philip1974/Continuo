// 右键单文件 trash → 对应 editor tab 自动关闭(removePaths),其他 tab 保留.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_TABS, editorTab } from './helpers/editor';
import { EXPLORER_TRASH, confirmExplorerTrash } from './helpers/explorer';

test('开 a.ts + b.ts → trash a.ts → a tab 关 + b 保留', async ({
  window,
  workspaceRoot,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts');
  await window.locator('text=b.ts').first().click();
  await expect(window.locator('header').first()).toContainText('b.ts');

  // 右键 a.ts → 移到废纸篓
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^a\.ts$/ })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();
  await confirmExplorerTrash(window);

  // 先确认 a.ts 已从磁盘删除(trash 真的发生),再断言编辑器 tab:只剩 b.ts,a.ts 的 tab 已关闭
  await expect
    .poll(() => existsSync(path.join(workspaceRoot, 'src/a.ts')), { timeout: 5_000 })
    .toBe(false);
  const tabs = window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab');
  await expect(tabs).toHaveCount(1, { timeout: 5_000 });
  await expect(editorTab(window, /^b\.ts/)).toBeVisible();
  await expect(
    window.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab').filter({ hasText: /^a\.ts/ }),
  ).toHaveCount(0);
});
