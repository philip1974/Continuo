// Modal overlay 区域点击 → onClose 触发 → modal 关闭(以 QuickOpen 为载体).
import { test, expect } from './fixtures/electron-app';

test('Ctrl+P 打开 QuickOpen → 点 overlay → 关闭', async ({ window }) => {
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
  const overlay = window.locator('.wm-modal-overlay');
  await expect(overlay).toBeVisible();

  // 点 overlay 角(避开 modal-content 区域,左上角是 overlay)
  await overlay.click({ position: { x: 5, y: 5 } });
  await expect(overlay).toBeHidden({ timeout: 5_000 });
});

test('点 modal-content 内部 → 不会关闭', async ({ window }) => {
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
  const overlay = window.locator('.wm-modal-overlay');
  const content = window.locator('.wm-modal-content');
  await expect(content).toBeVisible();

  // 点 modal-content(stopPropagation 阻断 overlay click)
  await content.click({ position: { x: 100, y: 30 } });
  await expect(overlay).toBeVisible();
});
