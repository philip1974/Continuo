// BDD: src/__tests__/hotkey-modal-suppression —— Modal 打开时不执行工作台快捷键(对齐 VSCode 对话框)。
// 删除确认框开着时按 ⌘T / Ctrl+T:不在背后新建终端,焦点仍在确认框内;关掉确认框后 ⌘T 照常新建终端。
import { test, expect } from './fixtures/with-workspace';
import { EXPLORER_TRASH } from './helpers/explorer';
import { TERMINAL_PANEL_TAB } from './helpers/editor';

test('删除确认框开着:⌘T 不新建终端、焦点留在框内;关闭后 ⌘T 照常', async ({ window }) => {
  const terminalTabs = window.getByRole('tab').filter({ hasText: TERMINAL_PANEL_TAB });
  const before = await terminalTabs.count();

  await window.locator('text=README.md').first().click({ button: 'right' });
  await window.getByRole('menuitem', { name: EXPLORER_TRASH }).click();
  // 确认框是 design Modal(role 为 dialog / alertdialog 视确认框实现而定),按 Modal 内容容器定位。
  const dialog = window.locator('.wm-modal-content');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect
    .poll(() => dialog.evaluate((el) => el.contains(el.ownerDocument.activeElement)))
    .toBe(true);

  await window.keyboard.press('ControlOrMeta+t');
  // 给命令(若被错误执行)足够时间建会话、挂载面板
  await window.waitForTimeout(1_000);
  expect(await terminalTabs.count()).toBe(before);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.contains(el.ownerDocument.activeElement))).toBe(true);

  await window.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await window.keyboard.press('ControlOrMeta+t');
  await expect.poll(() => terminalTabs.count(), { timeout: 15_000 }).toBe(before + 1);
});
