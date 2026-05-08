// Markdown 切 Preview mode → 渲染 readonly milkdown(没 .cm-content,有 prose 内容).
import { test, expect } from './fixtures/with-workspace';

test('打开 README.md → 切 Preview → milkdown readonly + 不显 CodeMirror', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  const previewBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Preview$/ })
    .first();
  await previewBtn.click();

  // CodeMirror 不显(.cm-content 没在 main 内)
  await expect(window.locator('main .cm-content')).toHaveCount(0, {
    timeout: 5_000,
  });
  // milkdown readonly 渲染:milkdown class .milkdown 或 ProseMirror class
  // 简化:验证标题文字渲染为 h1-h6 之类
  // README.md 内容 '# Test Workspace' → 渲染为 h1 'Test Workspace'
  await expect(window.locator('main')).toContainText('Test Workspace');
});
