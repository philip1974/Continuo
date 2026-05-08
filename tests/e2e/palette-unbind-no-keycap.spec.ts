// override settings.open 为空字符串(unbind)→ palette 该项不显 KeyCap.
import { test, expect } from './fixtures/electron-app';

test('unbind settings.open → palette 该项无 KeyCap', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 先打开 palette,验证默认有 KeyCap
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
  const item = window.locator('.wm-modal-content li').first();
  await expect(item).toBeVisible();
  expect(await item.locator('kbd.wm-keycap').count()).toBeGreaterThan(0);

  // 关 + unbind
  await window.keyboard.press('Escape');
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setHotkey: (commandId: string, hotkey: string) => void;
        };
      }
    ).__continuoTest;
    t.setHotkey('settings.open', ''); // unbind
  });

  // 重开 palette
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
  const input2 = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input2).toBeVisible();
  await input2.fill('打开 Settings');
  const item2 = window.locator('.wm-modal-content li').first();
  await expect(item2).toBeVisible();

  // 应不显 KeyCap
  expect(await item2.locator('kbd.wm-keycap').count()).toBe(0);
});
