// 关闭所有 dock panel → EmptyState「所有面板都关掉了」+ 「恢复默认布局」按钮.
import { test, expect } from './fixtures/electron-app';

test('关闭 Editor panel → EmptyState + 恢复默认布局', async ({ window }) => {
  // 默认 layout 只有 Editor 一个 panel(layout.default.ts)
  // 找到 Editor tab 的 close 按钮(SharedTab close icon aria-label='Close Editor')
  const closeBtn = window.locator('button[aria-label="Close Editor"]');
  await expect(closeBtn).toHaveCount(1, { timeout: 10_000 });

  // 关闭(走 wrapPanelClose 220ms 动画后真 close)
  await closeBtn.click();
  // 等动画完成
  await window.waitForTimeout(400);

  // EmptyState 出现
  const emptyState = window.locator('[data-testid="empty-state"]');
  await expect(emptyState).toBeVisible({ timeout: 5_000 });
  await expect(emptyState).toContainText('所有面板都关掉了');

  // 点「恢复默认布局」→ Editor panel 回来
  await emptyState
    .getByRole('button', { name: '恢复默认布局' })
    .click();

  await expect(emptyState).toBeHidden({ timeout: 5_000 });
});
