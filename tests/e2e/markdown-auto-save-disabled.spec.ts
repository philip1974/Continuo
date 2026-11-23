// 关闭 autoSave.markdown.enabled → 即使是 .md,改 store 内容也不自动保存.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
const UNSAVED_CHANGES = /^(未保存的更改|Unsaved changes|저장되지 않은 변경 사항)$/;

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
  // 修改确实生效(tab 变 dirty),否则下面「未写盘」会空过
  expect(tabId).toBeTruthy();
  await expect(window.getByText(UNSAVED_CHANGES).first()).toBeVisible();

  // 等若干倍 delay 时间,确认仍未写盘
  // delayMs=50 被钳到 500ms 下限:等 3 倍以上,若自动保存错误启用此时必已写盘
  await window.waitForTimeout(1_600);
  const after = await readFile(
    path.join(workspaceRoot, 'README.md'),
    'utf8',
  );
  expect(after).toBe(before);
});
