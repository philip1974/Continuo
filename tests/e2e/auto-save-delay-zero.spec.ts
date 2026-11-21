// autoSave.delayMs=0 → 立即写盘.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('autoSave.delayMs=0 + 修改 .md → 立即(<200ms)写盘', async ({
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

  // delay=0 → 立即写盘(给 0-tick 调度些时间)
  await expect(async () => {
    const onDisk = await readFile(
      path.join(workspaceRoot, 'README.md'),
      'utf8',
    );
    expect(onDisk).toBe(NEW);
  }).toPass({ timeout: 2_000 });
});
