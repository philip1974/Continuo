// Markdown 文件 → SegmentedControl 切到 Source mode → CodeMirror 显示 raw markdown
// (而非 milkdown 渲染).
import { test, expect } from './fixtures/with-workspace';

test('打开 README.md → 切 Source → CodeMirror 出现 + 含 raw markdown', async ({
  window,
}) => {
  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // 默认 mode='edit',milkdown 渲染.切 Source 让 CodeEditor 接管.
  const sourceBtn = window
    .locator('main')
    .locator('button')
    .filter({ hasText: /^Source$/ })
    .first();
  await sourceBtn.click();

  // CodeMirror 出现 + 显示 markdown 原文(包括 # 字符)
  await expect(window.locator('.cm-content')).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.locator('.cm-content')).toContainText(
    'Test Workspace',
  );
});
