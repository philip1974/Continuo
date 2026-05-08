// register 5 命令 → palette 输 'Bulk' → 5 个 li 都显.
import { test, expect } from './fixtures/electron-app';

test('register 5 Bulk* + palette 输 Bulk → 列表 5 项', async ({ window }) => {
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
          registerCommand: (id: string, title: string) => () => void;
        };
      }
    ).__continuoTest;
    for (let i = 0; i < 5; i++) {
      t.registerCommand(`e2e.bulk-${i}`, `Bulk Cmd ${i}`);
    }
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
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();
  await input.fill('Bulk Cmd');

  const items = window.locator('.wm-modal-content li');
  await expect(items).toHaveCount(5, { timeout: 5_000 });
});
