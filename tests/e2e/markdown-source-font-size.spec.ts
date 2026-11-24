// .md Source mode → CodeMirror 接管 → fontSize 影响.
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_MODE_SOURCE, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';

test('README.md Source mode + fontSize=24 → CM 容器 24px', async ({ window }) => {
  await openWorkspaceFile(window, ['README.md']);

  await editorModeButton(window, EDITOR_MODE_SOURCE).click();

  // CodeMirror 出现
  await expect(window.locator('main .cm-content')).toBeVisible({
    timeout: 10_000,
  });

  // 改 fontSize
  await waitForTestHooks(window);
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.setSettingValue('editor.fontSize', 24);
  });

  await expect(async () => {
    const fs = await window.evaluate(() => {
      const cm = document.querySelector('.cm-editor');
      if (!cm || !cm.parentElement) return null;
      return cm.parentElement.style.fontSize;
    });
    expect(fs).toBe('24px');
  }).toPass({ timeout: 5_000 });
});
