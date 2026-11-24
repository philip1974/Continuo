// editor.fontSize 改 → Markdown Preview mode 不渲染 CodeMirror;改字号后 Preview(只读 Milkdown)仍正常渲染.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_PREVIEW, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

test('Preview mode 改 fontSize → main 内 CodeMirror 不存在', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);
  // 切 Preview
  await editorModeButton(window, EDITOR_MODE_PREVIEW).click();

  // 先确认 Preview 已渲染(只读 Milkdown 把 '# Test Workspace' 渲染为 h1;Source 模式的 CodeMirror 行不是 h1)
  await expect(window.locator('main h1', { hasText: 'Test Workspace' })).toBeVisible({ timeout: 10_000 });
  // CodeMirror 在 main 内不存在
  await expect(window.locator('main .cm-content')).toHaveCount(0, {
    timeout: 5_000,
  });

  // 改 fontSize 不抛
  await waitForTestHooks(window)
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: { setSettingValue: (id: string, v: number) => void };
      }
    ).__continuoTest;
    t.setSettingValue('editor.fontSize', 22);
  });

  // Preview 仍渲(h1 文本)
  await expect(window.locator('main h1', { hasText: 'Test Workspace' })).toBeVisible({
    timeout: 5_000,
  });
});
