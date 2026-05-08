// focusPanel 不存在 id → 不抛 + 当前 panel 不变.
import { test, expect } from './fixtures/electron-app';

test('focusPanel("does-not-exist") → 不抛 + EditorWelcome 仍显', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 默认 → Editor panel + EditorWelcome
  await expect(window.getByText('未打开文件').first()).toBeVisible();

  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: { focusPanel: (id: string) => void };
      }
    ).__continuoTest;
    t.focusPanel('does-not-exist-panel-id');
  });

  // 仍 EditorWelcome
  await expect(window.getByText('未打开文件').first()).toBeVisible();
});
