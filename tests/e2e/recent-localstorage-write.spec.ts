// CommandPalette recent 持久化:执行命令 → localStorage 'continuo:command-palette:recent'.
import { test, expect } from './fixtures/electron-app';

test('执行 settings.open → localStorage recent 含 settings.open id', async ({
  window,
}) => {
  await expect(window.locator('button[title="设置"]')).toBeVisible({
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
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();
  await input.fill('打开 Settings');
  await window.keyboard.press('Enter');
  await expect(input).toBeHidden();

  // localStorage 写入
  const raw = await window.evaluate(() =>
    localStorage.getItem('continuo:command-palette:recent'),
  );
  expect(raw).not.toBeNull();
  const list = JSON.parse(raw!) as Array<{ id: string; ts: number }>;
  expect(list[0]?.id).toBe('settings.open');
});
