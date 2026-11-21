// README.md '# Test Workspace' Preview → 渲染为 h1 元素 (milkdown ProseMirror).
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';

test('Preview README.md → main 内含 h1 文本「Test Workspace」', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);

  const previewBtn = editorModeButton(window, EDITOR_MODE_PREVIEW);
  await previewBtn.click();

  // h1 in main(milkdown 把 `# Test Workspace` 渲染为 h1 元素)
  await expect(window.locator('main h1', { hasText: 'Test Workspace' })).toBeVisible({
    timeout: 10_000,
  });
});
