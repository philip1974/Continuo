// 关闭 autoSave.markdown.enabled → 即使是 .md,改 store 内容也不自动保存.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('autoSave.markdown.enabled=false → updateContent → 磁盘不变', async ({
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

  // 关 autoSave + delay 短
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: boolean | number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('autoSave.markdown.enabled', false);
    t.setSettingValue('autoSave.delayMs', 50);
  });

  await window.locator('text=README.md').first().click();
  await expect(window.locator('header').first()).toContainText('README.md', {
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
    path.join(workspaceRoot, 'README.md'),
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
    { tabId, content: '# Should NOT auto save\n' },
  );

  // 等若干倍 delay 时间,确认仍未写盘
  await window.waitForTimeout(500);
  const after = await readFile(
    path.join(workspaceRoot, 'README.md'),
    'utf8',
  );
  expect(after).toBe(before);
});
