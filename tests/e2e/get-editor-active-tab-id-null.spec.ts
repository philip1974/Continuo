// 启动后无 tab → getEditorActiveTabId() = null.
import { test, expect } from './fixtures/electron-app';

test('启动后 → getEditorActiveTabId 返回 null', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  const tabId = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { getEditorActiveTabId: () => string | null };
        }
      ).__continuoTest.getEditorActiveTabId(),
  );
  expect(tabId).toBeNull();
});
