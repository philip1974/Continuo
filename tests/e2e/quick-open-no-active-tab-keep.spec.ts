// Quick Open 关闭后 → editor 中 active tab 不变.
import { test, expect } from './fixtures/with-workspace';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const EDITOR_TABS = /^(编辑器标签|Editor tabs|편집기 탭)$/;

test('打开 README.md → Quick Open 选 a.ts → README.md tab 仍在 + a.ts 新 tab', async ({
  window,
}) => {
  await window
    .locator('[role=treeitem]')
    .filter({ hasText: /^README\.md$/ })
    .first()
    .click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // Quick Open 打开
  await openQuickOpen(window);
  const input = quickOpenInput(window);
  await expect(input).toBeVisible();
  await input.fill('a.ts');
  const item = window
    .locator('.wm-modal-content li')
    .filter({ hasText: 'a.ts' })
    .first();
  await expect(item).toBeVisible();

  await item.click();
  await expect(input).toBeHidden();

  // 现在有 2 个 tab
  const tabs = window
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.filter({ hasText: 'README.md' })).toHaveCount(1);
  await expect(tabs.filter({ hasText: 'a.ts' })).toHaveCount(1);
});
