// 右键 → 在 Finder 中显示 = shell.showItemInFolder(IPC).
// e2e 真调系统 API 会弹 Finder,我们只验证调用不抛 + menu 关闭.
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_REVEAL_IN_FINDER, explorerTreeItem } from './helpers/explorer';

test('右键 README.md → 「在 Finder 中显示」 → 不抛 + 菜单关', async ({ window }) => {
  await explorerTreeItem(window, /^README\.md$/).click({ button: 'right' });
  const item = window.getByRole('menuitem', {
    name: EXPLORER_REVEAL_IN_FINDER,
  });
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();

  // 菜单关 + 主窗仍正常(若 IPC 抛会让 main 崩溃)
  await expect(window.getByRole('menu')).toBeHidden();
  await expect(window.locator('header').first()).toBeVisible();
});
