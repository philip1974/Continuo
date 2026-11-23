// 编辑器 mode 是 store 全局状态;切换 tab 后,回到原 tab,mode 仍是上次值.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_PREVIEW,
  editorModeButton,
  editorTab,
  openWorkspaceFile,
} from './helpers/editor';

test('README.md → Preview(非默认)→ 切到 a.ts → 切回 README.md → 仍 Preview', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);

  // 切 Preview(默认是 Source,切到非默认值才能区分是否保留)
  const previewBtn = editorModeButton(window, EDITOR_MODE_PREVIEW);
  await previewBtn.click();
  await expect(previewBtn).toHaveAttribute('aria-checked', 'true');

  // 打开 a.ts(.ts 文件无 segmented control)
  await openWorkspaceFile(window, ['src', 'a.ts']);

  // 回 README.md tab
  const readmeTab = editorTab(window, 'README.md');
  await readmeTab.click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // mode 仍 Preview(全局)
  const previewBtn2 = editorModeButton(window, EDITOR_MODE_PREVIEW);
  await expect(previewBtn2).toHaveAttribute('aria-checked', 'true');
});
