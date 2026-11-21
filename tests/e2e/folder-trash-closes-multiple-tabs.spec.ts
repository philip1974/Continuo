import { EDITOR_NO_FILE_OPEN, EDITOR_TABS } from './helpers/editor';
import { EXPLORER_TRASH } from './helpers/explorer';
// trash src/ → 内部所有 tab 一并关闭(removePath 前缀匹配).
import { test, expect } from './fixtures/with-workspace';

test('开 src/a.ts + src/b.ts → trash src → 两 tabs 都关 + EditorWelcome', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await window.locator('text=b.ts').first().click();

  // 2 tabs 模式
  const items = window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab');
  await expect(items).toHaveCount(2);

  // trash src
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: 'src' })
    .first()
    .click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();

  // 两 tabs 都关 → EditorWelcome
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({
    timeout: 5_000,
  });
});
