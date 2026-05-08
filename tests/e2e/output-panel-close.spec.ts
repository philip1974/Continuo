// Output panel 添加后,点 Close Output → panel 关闭.
import { test, expect } from './fixtures/electron-app';

test('open Output → close → 「Continuo ready」消失', async ({ window }) => {
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

  await window.locator('button[aria-label="Close Output"]').click();
  // 等关闭动画
  await window.waitForTimeout(300);
  await expect(window.locator('text=Continuo ready')).toBeHidden({
    timeout: 5_000,
  });
});
