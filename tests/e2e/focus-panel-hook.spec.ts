// focusPanel testing hook → 切 active panel.
import { test, expect } from './fixtures/electron-app';
import { openSettings } from './helpers/settings';
import { OUTPUT_READY, openOutputPanel } from './helpers/output';

test('开 Output → 开 Settings(active)→ focusPanel("output") → Output active', async ({
  window,
}) => {
  // 开 Output
  await openOutputPanel(window);

  // 开 Settings(覆盖 active)
  await openSettings(window);

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
  await expect(window.getByText(OUTPUT_READY)).toBeVisible({
    timeout: 5_000,
  });
});
