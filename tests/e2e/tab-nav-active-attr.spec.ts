// TabNav 切 tab → wm-tab-nav-item data-active 同步;data-active=true 的只有 1 个.
import { test, expect } from './fixtures/with-workspace';
import { editorTabItem, openWorkspaceFile } from './helpers/editor';

test('切 tab → 当前 item data-active=true,其他 false', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  await openWorkspaceFile(window, ['src', 'a.ts']);
  // 现在 active = a.ts

  const aItem = editorTabItem(window, 'a.ts');
  const readmeItem = editorTabItem(window, 'README.md');
  await expect(aItem).toHaveAttribute('data-active', 'true');
  await expect(readmeItem).toHaveAttribute('data-active', 'false');

  // 点 README.md tab
  await readmeItem.locator('button[role=tab]').click();
  await expect(window.locator('header').first()).toContainText('README.md');

  await expect(readmeItem).toHaveAttribute('data-active', 'true');
  await expect(aItem).toHaveAttribute('data-active', 'false');
});
