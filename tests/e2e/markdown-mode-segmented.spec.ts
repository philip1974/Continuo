// .md 文件打开后,EditorHeader SegmentedControl 切换 Edit/Source/Preview.
// 切换写 editor.store.mode,影响 EditorPanel body 渲染.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_PREVIEW,
  EDITOR_MODE_SOURCE,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';

test('Source (默认) → Preview 切换', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);

  const editBtn = editorModeButton(window, EDITOR_MODE_EDIT);
  const sourceBtn = editorModeButton(window, EDITOR_MODE_SOURCE);
  const previewBtn = editorModeButton(window, EDITOR_MODE_PREVIEW);

  await expect(editBtn).toBeVisible();
  await expect(sourceBtn).toBeVisible();
  await expect(previewBtn).toBeVisible();

  // 默认 mode='source', Source 按钮 active.
  await expect(sourceBtn).toHaveAttribute('aria-checked', 'true');
  await expect(editBtn).toHaveAttribute('aria-checked', 'false');

  // 切到 Preview
  await previewBtn.click();
  await expect(previewBtn).toHaveAttribute('aria-checked', 'true');
});
