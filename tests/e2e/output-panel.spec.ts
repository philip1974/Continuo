// Output panel:openOrFocusPanel → 显「Continuo ready」「dock layout restored」.
import { test, expect } from './fixtures/electron-app';

test('打开 Output panel → 显占位 log 行', async ({ window }) => {
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
  });

  await expect(window.locator('text=Continuo ready')).toBeVisible({
    timeout: 10_000,
  });
  await expect(window.locator('text=dock layout restored')).toBeVisible();
});
