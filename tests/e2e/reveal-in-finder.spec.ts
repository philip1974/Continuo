// 右键 → 在 Finder 中显示 = shell.showItemInFolder(IPC).
// e2e 真调系统 API 会弹 Finder,我们只验证调用不抛 + menu 关闭.
import { test, expect } from './fixtures/with-workspace';

test('右键 README.md → 「在 Finder 中显示」 → 不抛 + 菜单关', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click({ button: 'right' });
  const item = window.getByRole('menuitem', {
    name: /在 Finder 中显示/,
  });
  await expect(item).toBeVisible({ timeout: 5_000 });
  await item.click();

  // 菜单关 + 主窗仍正常(若 IPC 抛会让 main 崩溃)
  await expect(window.getByRole('menu')).toBeHidden();
  await expect(window.locator('header').first()).toBeVisible();
});
