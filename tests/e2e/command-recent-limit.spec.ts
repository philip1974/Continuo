// CommandPalette recent:MAX_RECENT=20,LRU 顺序;
// 重复执行同 id → 移到头部不重复.
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

test('多次执行同命令 → recent 不重复 + 该命令始终置顶', async ({
  window,
}) => {
  // 等就绪
  await expect(window.locator('button[title="设置"]')).toBeVisible({
    timeout: 10_000,
  });

  // 三次执行 settings.open
  for (let i = 0; i < 3; i++) {
    await openPalette(window);
    const input = window.locator(
      '.wm-modal-content input[placeholder^="输入命令名"]',
    );
    await expect(input).toBeVisible();
    await input.fill('打开 Settings');
    await window.keyboard.press('Enter');
    await expect(input).toBeHidden();

    // 关掉 settings panel(避免堆叠)
    const closeSettings = window.locator(
      'button[aria-label="Close Settings"]',
    );
    if (await closeSettings.count()) {
      await closeSettings.click();
      await window.waitForTimeout(300);
    }
  }

  // 第四次打开命令面板 → 第一项仍是 Settings 相关(LRU 头部不重复)
  await openPalette(window);
  const firstItem = window.locator('.wm-modal-content li').first();
  await expect(firstItem).toContainText(/Settings|设置/);

  // 由于 settings.open 是唯一带 Settings category 的命令,只占 1 个 li
  const settingsCount = await window
    .locator('.wm-modal-content li')
    .filter({ hasText: '打开 Settings' })
    .count();
  expect(settingsCount).toBe(1);
});
