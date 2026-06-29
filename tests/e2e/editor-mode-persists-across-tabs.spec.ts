// 编辑器 mode 是 store 全局状态;切换 tab 后,回到原 tab,mode 仍是上次值.
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_SOURCE,
  editorModeButton,
  editorTab,
  openWorkspaceFile,
} from './helpers/editor';

test('README.md → Source → 切到 a.ts → 切回 README.md → 仍 Source', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);

  // 切 Source mode
  const sourceBtn = editorModeButton(window, EDITOR_MODE_SOURCE);
  await sourceBtn.click();
  await expect(sourceBtn).toHaveAttribute('aria-checked', 'true');

  // 打开 a.ts(.ts 文件无 segmented control)
  await openWorkspaceFile(window, ['src', 'a.ts']);

  // 回 README.md tab
  const readmeTab = editorTab(window, 'README.md');
  await readmeTab.click();
  await expect(window.locator('header').first()).toContainText('README.md');

  // mode 仍 Source(全局)
  const sourceBtn2 = editorModeButton(window, EDITOR_MODE_SOURCE);
  await expect(sourceBtn2).toHaveAttribute('aria-checked', 'true');
});
