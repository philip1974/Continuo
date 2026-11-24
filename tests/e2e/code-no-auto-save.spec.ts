// 代码文件 .ts 不自动保存,即使 autoSave.markdown.enabled=true.
// isAutoSaveEnabled 只对 .md/.markdown 返 true.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

const UNSAVED_CHANGES = /^(未保存的更改|Unsaved changes|저장되지 않은 변경 사항)$/;

test('打开 a.ts → updateContent → 不自动保存(代码必须 ⌘S)', async ({
  window,
  workspaceRoot,
}) => {
  await waitForTestHooks(window);

  // delay 短
  await window.evaluate(() => {
    globalThis.__continuoTest!.setSettingValue('autoSave.delayMs', 50);
  });

  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  const tabId = await window.evaluate(
    () =>
      globalThis.__continuoTest!.getEditorActiveTabId(),
  );
  const before = await readFile(
    path.join(workspaceRoot, 'src/a.ts'),
    'utf8',
  );

  await window.evaluate(
    ({ tabId, content }) => {
      globalThis.__continuoTest!.setEditorContent(tabId as string, content);
    },
    { tabId, content: 'export const a = 999;\n' },
  );

  // delayMs=50 被钳到 500ms 下限:等 3 倍以上,若自动保存错误启用此时必已写盘
  await window.waitForTimeout(1_600);
  const after = await readFile(
    path.join(workspaceRoot, 'src/a.ts'),
    'utf8',
  );
  // 代码不自动保存 → 内容未变
  expect(after).toBe(before);

  // 但 dirty 标记已显示(EditorHeader tab)
  await expect(window.getByText(UNSAVED_CHANGES).first()).toBeVisible();
});
