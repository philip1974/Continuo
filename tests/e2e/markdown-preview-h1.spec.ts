// README.md '# Test Workspace' Preview → 渲染为 h1 元素 (milkdown ProseMirror).
import { test, expect } from './fixtures/with-workspace';

test('Preview README.md → main 内含 h1 文本「Test Workspace」', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });

  const previewBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Preview$/ })
    .first();
  await previewBtn.click();

  // h1 in main(milkdown 把 `# Test Workspace` 渲染为 h1 元素)
  await expect(
    window.locator('main h1', { hasText: 'Test Workspace' }),
  ).toBeVisible({ timeout: 10_000 });
});
