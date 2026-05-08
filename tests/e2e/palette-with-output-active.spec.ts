// Output panel active → Cmd+Shift+P → palette modal 显.
import { test, expect } from './fixtures/electron-app';

test('Output active → Cmd+Shift+P → palette 显', async ({ window }) => {
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

  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(
    window.locator('.wm-modal-content input[placeholder^="输入命令名"]'),
  ).toBeVisible({ timeout: 5_000 });
});
