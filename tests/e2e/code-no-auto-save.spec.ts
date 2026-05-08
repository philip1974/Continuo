// 代码文件 .ts 不自动保存,即使 autoSave.markdown.enabled=true.
// isAutoSaveEnabled 只对 .md/.markdown 返 true.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → updateContent → 不自动保存(代码必须 ⌘S)', async ({
  window,
  workspaceRoot,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // delay 短
  await window.evaluate(() => {
    (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest.setSettingValue('autoSave.delayMs', 50);
  });

  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  await expect(window.locator('header').first()).toContainText('a.ts', {
    timeout: 10_000,
  });

  const tabId = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { getEditorActiveTabId: () => string | null };
        }
      ).__continuoTest.getEditorActiveTabId(),
  );
  const before = await readFile(
    path.join(workspaceRoot, 'src/a.ts'),
    'utf8',
  );

  await window.evaluate(
    ({ tabId, content }) => {
      (
        window as unknown as {
          __continuoTest: {
            setEditorContent: (id: string, c: string) => void;
          };
        }
      ).__continuoTest.setEditorContent(tabId as string, content);
    },
    { tabId, content: 'export const a = 999;\n' },
  );

  await window.waitForTimeout(500);
  const after = await readFile(
    path.join(workspaceRoot, 'src/a.ts'),
    'utf8',
  );
  // 代码不自动保存 → 内容未变
  expect(after).toBe(before);

  // 但 dirty 圆点已显示(EditorHeader 紧凑模式)
  await expect(
    window.locator('span[aria-label="未保存修改"]'),
  ).toBeVisible();
});
