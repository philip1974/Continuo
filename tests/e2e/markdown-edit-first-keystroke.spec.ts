// Edit 模式下第一次按键就要进 store(变脏)。回归:旧实现无条件吞掉 Milkdown 的第一次
// markdownUpdated,以段落结尾的文档(挂载期没有规范化 emit)会丢掉用户的第一次编辑。
import { test, expect } from './fixtures/with-workspace';
import {
  EDITOR_MODE_EDIT,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
  editorModeButton,
  openWorkspaceFile,
} from './helpers/editor';

test('Edit 模式:打开不变脏,第一次按键即变脏', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  await editorModeButton(window, EDITOR_MODE_EDIT).click();

  const heading = window.locator('main .milkdown h1');
  await expect(heading).toContainText('Test Workspace');
  // 仅打开不算编辑
  await window.waitForTimeout(600);
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);

  await heading.click();
  await window.keyboard.type('x');
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR).first()).toBeVisible({
    timeout: 5_000,
  });
});
