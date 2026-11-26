// BDD:src/__tests__/dock-reset-layout —— 命令「视图:重置布局」把 popout 子窗里的面板收回主窗(子窗关闭),面板不重建。
import { test, expect } from './fixtures/electron-app';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';
import { DOCK_POPOUT, EDITOR_NO_FILE_OPEN } from './helpers/editor';

test('编辑器弹到子窗后执行「重置布局」→ 子窗关闭,编辑器回到主窗', async ({ electronApp, window }) => {
  const popoutBtn = window.getByRole('button', { name: DOCK_POPOUT });
  await expect(popoutBtn).toBeEnabled({ timeout: 10_000 });
  await popoutBtn.click();
  await expect.poll(() => electronApp.windows().length, { timeout: 10_000 }).toBe(2);
  // 主窗此时没有面板(空状态:面板都在其他窗口)
  await expect(window.locator('[data-testid="empty-state"]')).toBeVisible({ timeout: 10_000 });

  await openCommandPalette(window);
  await commandPaletteInput(window).fill('Reset Layout');
  const option = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: /(重置布局|Reset Layout|레이아웃 초기화)/ });
  await expect(option).toHaveCount(1);
  await option.click();

  await expect.poll(() => electronApp.windows().length, { timeout: 10_000 }).toBe(1);
  await expect(window.locator('[data-testid="empty-state"]')).toBeHidden();
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 5_000 });
});
