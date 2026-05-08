// Modal data-size 属性:CommandPalette=md,QuickOpen=lg.
import { test, expect } from './fixtures/electron-app';

test('CommandPalette modal data-size=md', async ({ window }) => {
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
  const content = window.locator('.wm-modal-content');
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute('data-size', 'md');
});

test('QuickOpen modal data-size=lg', async ({ window }) => {
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
  const content = window.locator('.wm-modal-content');
  await expect(content).toBeVisible();
  await expect(content).toHaveAttribute('data-size', 'lg');
});
