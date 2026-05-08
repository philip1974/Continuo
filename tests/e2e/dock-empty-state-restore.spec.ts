// EmptyState 「恢复默认布局」 → addPanel(editor) → Editor 恢复 + EmptyState 消失.
import { test, expect } from './fixtures/electron-app';

test('EmptyState → 恢复 → Editor + EditorWelcome 都回来', async ({
  window,
}) => {
  await window.locator('button[aria-label="Close Editor"]').click();
  await window.waitForTimeout(400);
  const empty = window.locator('[data-testid="empty-state"]');
  await expect(empty).toBeVisible();

  await empty.getByRole('button', { name: '恢复默认布局' }).click();

  await expect(empty).toBeHidden();
  // Editor SharedTab close × 出现
  await expect(
    window.locator('button[aria-label="Close Editor"]'),
  ).toBeVisible({ timeout: 5_000 });
  // EditorWelcome 仍渲染(无 active tab)
  await expect(window.getByText('未打开文件').first()).toBeVisible();
});
