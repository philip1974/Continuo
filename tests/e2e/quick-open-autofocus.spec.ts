// Cmd+P 打开 → 焦点直接在搜索 input(可立刻输入).
import { test, expect } from './fixtures/electron-app';

test('Cmd+P 后 → 搜索 input 已聚焦', async ({ window }) => {
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
  // 等 modal 渲(Modal raf focus)
  await expect(
    window.locator('.wm-modal-content input[placeholder*="搜索文件名"]'),
  ).toBeVisible({ timeout: 5_000 });

  // activeElement 是该 input
  const placeholder = await window.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el?.placeholder ?? null;
  });
  expect(placeholder).toContain('搜索文件名');
});

test('Cmd+Shift+P 后 → 命令面板 input 已聚焦', async ({ window }) => {
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

  const placeholder = await window.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el?.placeholder ?? null;
  });
  expect(placeholder).toContain('输入命令名');
});
