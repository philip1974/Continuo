// openOrFocusPanel 二次 → 仍单例(不重复 addPanel).
import { test, expect } from './fixtures/electron-app';
import { OUTPUT_CLOSE, OUTPUT_READY, openOutputPanel } from './helpers/output';

test('openOrFocusPanel("output") 调 2 次 → 只 1 个 Output close ✕', async ({
  window,
}) => {
  await openOutputPanel(window);

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

  await expect(window.getByText(OUTPUT_READY)).toBeVisible({
    timeout: 10_000,
  });

  // 仅 1 个 Close Output 按钮
  const closeBtns = window.getByRole('button', { name: OUTPUT_CLOSE });
  await expect(closeBtns).toHaveCount(1);
});
