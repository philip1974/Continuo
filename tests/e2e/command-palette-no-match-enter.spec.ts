// CommandPalette 无匹配时按 Enter → 无 cmd 可执行,modal 仍开 + 不抛.
import { test, expect } from './fixtures/electron-app';

test('无匹配时 Enter → modal 仍开 + 不抛', async ({ window }) => {
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

  await input.fill('zzz_no_match_xx');
  await expect(window.locator('.wm-modal-content')).toContainText(
    '无匹配命令',
  );

  // Enter 不抛 + modal 不关(filtered[selectedIndex] 是 undefined)
  await window.keyboard.press('Enter');
  await expect(input).toBeVisible();
});
