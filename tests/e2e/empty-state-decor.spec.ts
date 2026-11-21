// 关 Editor 后 EmptyState 出现 → 内含 svg(BackgroundBeams + 占位 icon).
import { test, expect } from './fixtures/electron-app';
import {
  DOCK_CLOSE_EDITOR,
  DOCK_EMPTY_MESSAGE,
  DOCK_RESTORE_DEFAULT_LAYOUT,
} from './helpers/editor';

test('关 Editor → EmptyState 含 svg + 「所有面板都关掉了」', async ({
  window,
}) => {
  await window.getByRole('button', { name: DOCK_CLOSE_EDITOR }).click();
  const empty = window.locator('[data-testid="empty-state"]');
  await expect(empty).toBeVisible({ timeout: 5_000 });
  await expect(empty).toContainText(DOCK_EMPTY_MESSAGE);

  // 至少含 1 个 svg(占位 icon),通常含多个(BackgroundBeams)
  const svgCount = await empty.locator('svg').count();
  expect(svgCount).toBeGreaterThan(0);

  // 按钮 「恢复默认布局」 可见
  await expect(
    empty.getByRole('button', { name: DOCK_RESTORE_DEFAULT_LAYOUT }),
  ).toBeVisible();
});
