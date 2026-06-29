// EmptyState 「恢复默认布局」 → addPanel(editor) → Editor 恢复 + EmptyState 消失.
import { test, expect } from './fixtures/electron-app';
import {
  DOCK_CLOSE_EDITOR,
  DOCK_RESTORE_DEFAULT_LAYOUT,
  EDITOR_NO_FILE_OPEN,
} from './helpers/editor';

test('EmptyState → 恢复 → Editor + EditorWelcome 都回来', async ({
  window,
}) => {
  await window.getByRole('button', { name: DOCK_CLOSE_EDITOR }).click();
  await window.waitForTimeout(400);
  const empty = window.locator('[data-testid="empty-state"]');
  await expect(empty).toBeVisible();

  await empty.getByRole('button', { name: DOCK_RESTORE_DEFAULT_LAYOUT }).click();

  await expect(empty).toBeHidden();
  // Editor SharedTab close × 出现
  await expect(
    window.getByRole('button', { name: DOCK_CLOSE_EDITOR }),
  ).toBeVisible({ timeout: 5_000 });
  // EditorWelcome 仍渲染(无 active tab)
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible();
});
