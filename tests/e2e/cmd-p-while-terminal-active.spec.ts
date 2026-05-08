// Terminal panel active 时,Cmd+P 仍可全局打开 Quick Open(useCommandHotkeys 监 document).
import { test, expect } from './fixtures/with-workspace';

test('Terminal active + Cmd+P → Quick Open modal 显', async ({ window }) => {
  // 打开 Terminal panel
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
    t.openOrFocusPanel('terminal', 'terminal', 'Terminal');
  });
  await expect(
    window.locator('button[aria-label="新建终端"]'),
  ).toBeVisible({ timeout: 15_000 });

  // Cmd+P 触发 quick-open(全局 listener,Terminal 不阻断)
  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(
    window.locator('.wm-modal-content input[placeholder*="搜索文件名"]'),
  ).toBeVisible({ timeout: 5_000 });
});
