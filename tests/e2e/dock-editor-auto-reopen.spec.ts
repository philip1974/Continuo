// 关闭 Editor panel → 单击文件 → editor.activeTabId 变 → DockShell useEffect
// 自动 addPanel + setActive editor panel.
import { test, expect } from './fixtures/with-workspace';

test('关 Editor panel → 单击文件 → Editor panel 自动回来', async ({
  window,
}) => {
  // 关闭 Editor panel(SharedTab close button)
  const closeBtn = window.locator('button[aria-label="Close Editor"]');
  await expect(closeBtn).toHaveCount(1, { timeout: 10_000 });
  await closeBtn.click();
  // 等动画
  await window.waitForTimeout(400);

  // EmptyState 出现
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeVisible({ timeout: 5_000 });

  // 单击文件 → editor.store.activeTabId 变 → DockShell useEffect 自动 addPanel
  await window.locator('text=README.md').first().click();

  // EmptyState 消失,Editor panel 重新出现
  await expect(window.locator('[data-testid="empty-state"]')).toBeHidden({
    timeout: 5_000,
  });
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 5_000,
  });
});
