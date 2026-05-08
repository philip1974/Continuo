// focusPanel testing hook → 切 active panel.
import { test, expect } from './fixtures/electron-app';

test('开 Output → 开 Settings(active)→ focusPanel("output") → Output active', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 开 Output
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

  // 开 Settings(覆盖 active)
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible();

  // focusPanel('output') → Output 重新 active
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: { focusPanel: (id: string) => void };
      }
    ).__continuoTest;
    t.focusPanel('output');
  });

  // Output 内容显
  await expect(window.locator('text=Continuo ready')).toBeVisible({
    timeout: 5_000,
  });
});
