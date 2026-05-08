// 默认 hotkey ⌘+, → 打开 Settings panel.
import { test, expect } from './fixtures/electron-app';

test('Ctrl+, → Settings nav 出现', async ({ window }) => {
  // 等命令面板 commands 注册到位 + listener 挂上
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.waitForTimeout(500);

  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ',',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
});
