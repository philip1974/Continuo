// autoSave.delayMs=0 → 被钳到设置下限 500ms → 防抖后写盘(用例按 2s 内写盘断言).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';

test('autoSave.delayMs=0(钳到 500ms)+ 修改 .md → 防抖后写盘', async ({
  window,
  workspaceRoot,
}) => {
  await waitForTestHooks(window)

  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('autoSave.delayMs', 0);
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
  expect(tabId).toBeTruthy();

  const NEW = '# instant-saved\n';
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
    { tabId, content: NEW },
  );

  // delay=0 被钳到 500ms → 防抖后写盘
  await expect(async () => {
    const onDisk = await readFile(
      path.join(workspaceRoot, 'README.md'),
      'utf8',
    );
    expect(onDisk).toBe(NEW);
  }).toPass({ timeout: 2_000 });
});
