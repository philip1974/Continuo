// Modal Tab 键不离开 modal,且 modal 仍开.
import { test, expect } from './fixtures/electron-app';

test('CommandPalette 开 → Tab → modal 仍开', async ({ window }) => {
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

  // 多按几次 Tab,modal 仍开
  await window.keyboard.press('Tab');
  await window.keyboard.press('Tab');
  await window.keyboard.press('Tab');
  await expect(input).toBeVisible();
});
