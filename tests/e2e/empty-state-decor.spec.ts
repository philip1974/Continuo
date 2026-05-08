// 关 Editor 后 EmptyState 出现 → 内含 svg(BackgroundBeams + 占位 icon).
import { test, expect } from './fixtures/electron-app';

test('关 Editor → EmptyState 含 svg + 「所有面板都关掉了」', async ({
  window,
}) => {
  await window.locator('button[aria-label="Close Editor"]').click();
  const empty = window.locator('[data-testid="empty-state"]');
  await expect(empty).toBeVisible({ timeout: 5_000 });
  await expect(empty).toContainText('所有面板都关掉了');

  // 至少含 1 个 svg(占位 icon),通常含多个(BackgroundBeams)
  const svgCount = await empty.locator('svg').count();
  expect(svgCount).toBeGreaterThan(0);

  // 按钮 「恢复默认布局」 可见
  await expect(
    empty.getByRole('button', { name: '恢复默认布局' }),
  ).toBeVisible();
});
