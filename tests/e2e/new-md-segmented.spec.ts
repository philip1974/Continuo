// 新建 .md 文件 → 单击打开 → EditorHeader 显示 SegmentedControl(autoSaveEnabled=true).
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
} from './helpers/editor';
import {
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FILE_PLACEHOLDER,
} from './helpers/explorer';

test('新建 newdoc.md → 打开 → SegmentedControl 出现', async ({ window }) => {
  // 先展开 src 让其可见
  await window.locator('text=src').first().click();
  // 右键 src 目录 → 新建文件
  await window.locator('text=src').first().click({ button: 'right' });
  await window
    .getByRole('menuitem', { name: EXPLORER_NEW_FILE })
    .click();

  const input = window.getByRole('textbox', {
    name: EXPLORER_NEW_FILE_PLACEHOLDER,
  });
  await expect(input).toBeVisible();
  await input.fill('newdoc.md');
  await input.press('Enter');

  // 文件列表中出现 newdoc.md
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: 'newdoc.md' }),
  ).toBeVisible({ timeout: 10_000 });

  // 单击打开
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'newdoc.md' })
    .first()
    .click();
  await expect(window.locator('header').first()).toContainText('newdoc.md', {
    timeout: 10_000,
  });

  // SegmentedControl 显示
  const main = window.locator('main');
  await expect(main.locator('button').filter({ hasText: EDITOR_MODE_EDIT })).toBeVisible();
  await expect(
    main.locator('button').filter({ hasText: EDITOR_MODE_PREVIEW }),
  ).toBeVisible();
});
