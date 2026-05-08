// openOrFocusPanel 二次 → 仍单例(不重复 addPanel).
import { test, expect } from './fixtures/electron-app';

test('openOrFocusPanel("output") 调 2 次 → 只 1 个 Output close ✕', async ({
  window,
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
          openOrFocusPanel: (id: string, c: string, t: string) => void;
        };
      }
    ).__continuoTest;
    t.openOrFocusPanel('output', 'output', 'Output');
    t.openOrFocusPanel('output', 'output', 'Output');
  });

  await expect(window.locator('text=Continuo ready')).toBeVisible({
    timeout: 10_000,
  });

  // 仅 1 个 Close Output 按钮
  const closeBtns = window.locator('button[aria-label="Close Output"]');
  await expect(closeBtns).toHaveCount(1);
});
