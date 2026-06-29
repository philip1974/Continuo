// 关 Editor → tree 单击文件 → editor.openTab → dock 自动重建 editor panel.
import { test, expect } from './fixtures/with-workspace';

const CLOSE_EDITOR =
  /^(Close (Editor|编辑器|편집기)|关闭 (Editor|编辑器|편집기)|(Editor|编辑器|편집기) 닫기)$/;

test('关 Editor → tree click README.md → Editor 自动重建', async ({
  window,
}) => {
  await window.getByRole('button', { name: CLOSE_EDITOR }).click();
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeVisible({ timeout: 5_000 });

  await window.getByRole('treeitem', { name: /README\.md/ }).click();

  await expect(window.getByText('README.md').first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeHidden({ timeout: 5_000 });
});
