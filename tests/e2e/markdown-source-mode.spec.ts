// Markdown 文件 → SegmentedControl 切到 Source mode → CodeMirror 显示 raw markdown
// (而非 milkdown 渲染).
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';

test('打开 README.md → 切 Preview → 再切 Source → CodeMirror 出现 + 含 raw markdown', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);

  // 默认 mode='source':先切到 Preview(CodeMirror 消失),再切回 Source,验证 CodeEditor 重新接管.
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();
  await expect(window.locator('.cm-content')).toHaveCount(0, { timeout: 10_000 });
  const sourceBtn = editorModeButton(window, EDITOR_MODE_SOURCE);
  await sourceBtn.click();

  // CodeMirror 出现 + 显示 markdown 原文(包括 # 字符)
  await expect(window.locator('.cm-content')).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.locator('.cm-content')).toContainText('Test Workspace');
});
