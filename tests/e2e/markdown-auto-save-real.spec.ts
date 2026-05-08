// Markdown 自动保存真触发:store.updateContent + autoSave delay → 磁盘写入.
//
// 不依赖 milkdown 真实输入。通过 testing hook 直接调 editor.store.updateContent
// 让 useAutoSave 监到 dirty=true,等 delayMs 后调 saveActive.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';

test('打开 .md → updateContent(via hook)→ 等 delay → 磁盘写入新内容', async ({
  window,
  workspaceRoot,
}) => {
  // 等 testing hook 挂载
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 把 autoSave delay 设短(50ms)避免 e2e 等久
  await window.evaluate(() => {
    (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest.setSettingValue('autoSave.delayMs', 50);
  });

  // 打开 README.md
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

  // 通过 hook 改 store(直接 updateContent)
  const NEW_CONTENT = '# Auto-saved by e2e\n\nbody.\n';
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
    { tabId, content: NEW_CONTENT },
  );

  // 等 useAutoSave debounce(50ms)+ saveActive IPC writeFile
  await expect(async () => {
    const onDisk = await readFile(
      path.join(workspaceRoot, 'README.md'),
      'utf8',
    );
    expect(onDisk).toBe(NEW_CONTENT);
  }).toPass({ timeout: 5_000 });
});
