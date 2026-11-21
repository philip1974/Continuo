// 新建 .ts 代码文件 → SegmentedControl 不显(autoSaveEnabled=false 路径).
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_EDIT, EDITOR_SAVE_LABEL } from './helpers/editor';
import {
  EXPLORER_NEW_FILE,
  EXPLORER_NEW_FILE_PLACEHOLDER,
} from './helpers/explorer';

test('新建 hello.ts → 打开 → 不显保存按钮 + 不显 SegmentedControl', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=src').first().click({ button: 'right' });
  await window
    .getByRole('menuitem', { name: EXPLORER_NEW_FILE })
    .click();

  const input = window.getByRole('textbox', {
    name: EXPLORER_NEW_FILE_PLACEHOLDER,
  });
  await input.fill('hello.ts');
  await input.press('Enter');

  // 等文件出现 + 自动 reveal/打开?(默认不打开,需要单击)
  await expect(
    window.locator('[role=treeitem]').filter({ hasText: 'hello.ts' }),
  ).toBeVisible({ timeout: 10_000 });
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'hello.ts' })
    .first()
    .click();
  await expect(window.locator('header').first()).toContainText('hello.ts');

  // 「保存」按钮不显
  const main = window.locator('main');
  await expect(
    window.getByRole('button', { name: EDITOR_SAVE_LABEL }),
  ).toHaveCount(0);

  // SegmentedControl 不显:Edit / Source / Preview 按钮不可见
  // (SegmentedControl 仅 markdown 时渲染)
  expect(
    await main
      .locator('button, [role=tab]')
      .filter({ hasText: EDITOR_MODE_EDIT })
      .count(),
  ).toBe(0);
});
