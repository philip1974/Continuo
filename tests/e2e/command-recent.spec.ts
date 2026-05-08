// 命令面板 recent:执行某命令后,下次空 query 时该命令置顶.
import { test, expect } from './fixtures/electron-app';

async function openPalette(window: import('@playwright/test').Page): Promise<void> {
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
}

test('执行 settings.open → 关 + 重开 → recent 第一项是 Settings 相关', async ({
  window,
}) => {
  // 第一次:搜「Settings」执行
  await openPalette(window);
  const input = window.locator(
    '.wm-modal-content input[placeholder^="输入命令名"]',
  );
  await expect(input).toBeVisible();
  await input.fill('Settings');
  await expect(window.locator('.wm-modal-content li').first()).toBeVisible();
  // Enter 执行(打开 Settings panel)
  await window.keyboard.press('Enter');
  await expect(input).toBeHidden();

  // 第二次:打开命令面板,空 query 时第一项应是刚才执行的命令
  await openPalette(window);
  await expect(input).toBeVisible();
  // 第一项 li 含 「Settings」(category 或 title)
  const firstItem = window.locator('.wm-modal-content li').first();
  await expect(firstItem).toContainText(/Settings|设置/);

  await window.keyboard.press('Escape');
});
