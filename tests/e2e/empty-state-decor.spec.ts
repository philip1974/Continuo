// 关 Editor 后 EmptyState 出现 → 内含 svg(BackgroundBeams + 占位 icon).
import { test, expect } from './fixtures/electron-app';
import {
  DOCK_CLOSE_EDITOR,
  DOCK_EMPTY_MESSAGE,
  DOCK_POPOUT,
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

// 第六十九轮 A 组审计:面板都弹出到 popout、主窗聚焦时,主窗空态的背景动画让空闲 CPU / GPU 一直约 16–18%。
// 面板都在其他窗口中 → 主窗空态不放装饰动画(VSCode 空编辑区水印静态)。BDD: src/__tests__/empty-state/
test('面板都弹出到 popout:主窗空态不渲染背景动画(只有占位 icon)', async ({ electronApp, window }) => {
  const popout = window.getByRole('button', { name: DOCK_POPOUT });
  await expect(popout).toBeEnabled({ timeout: 10_000 });
  await popout.click();
  await expect.poll(() => electronApp.windows().length).toBeGreaterThan(1);
  const empty = window.locator('[data-testid="empty-state"]');
  await expect(empty).toContainText(/(其他窗口|other windows|다른 창)/, { timeout: 10_000 });
  await window.waitForTimeout(300);
  expect(await empty.locator('svg').count()).toBe(1);
});
