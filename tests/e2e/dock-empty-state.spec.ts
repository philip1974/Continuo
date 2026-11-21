// 关闭所有 dock panel → EmptyState「所有面板都关掉了」+ 「恢复默认布局」按钮.
import { test, expect } from './fixtures/electron-app';
import {
  DOCK_CLOSE_EDITOR,
  DOCK_EMPTY_MESSAGE,
  DOCK_RESTORE_DEFAULT_LAYOUT,
} from './helpers/editor';

test('关闭 Editor panel → EmptyState + 恢复默认布局', async ({ window }) => {
  // 默认 layout 只有 Editor 一个 panel(layout.default.ts)
  // 找到 Editor tab 的本地化 close 按钮.
  const closeBtn = window.getByRole('button', { name: DOCK_CLOSE_EDITOR });
  await expect(closeBtn).toHaveCount(1, { timeout: 10_000 });

  // 关闭(走 wrapPanelClose 220ms 动画后真 close)
  await closeBtn.click();
  // 等动画完成
  await window.waitForTimeout(400);

  // EmptyState 出现
  const emptyState = window.locator('[data-testid="empty-state"]');
  await expect(emptyState).toBeVisible({ timeout: 5_000 });
  await expect(emptyState).toContainText(DOCK_EMPTY_MESSAGE);

  // 点「恢复默认布局」→ Editor panel 回来
  await emptyState
    .getByRole('button', { name: DOCK_RESTORE_DEFAULT_LAYOUT })
    .click();

  await expect(emptyState).toBeHidden({ timeout: 5_000 });
});
