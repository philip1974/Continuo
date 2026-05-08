// 关 Editor → Cmd+P 选文件 → editor.store.openTab → DockShell useEffect 自动 addPanel.
import { test, expect } from './fixtures/with-workspace';

test('关 Editor → Cmd+P 选 README.md → Editor 自动重建 + 显 README.md', async ({
  window,
}) => {
  // 关 Editor → EmptyState
  await window.locator('button[aria-label="Close Editor"]').click();
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeVisible({ timeout: 5_000 });

  // Cmd+P → 选 README.md
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
  const input = window.locator(
    '.wm-modal-content input[placeholder*="搜索文件名"]',
  );
  await expect(input).toBeVisible();
  await input.fill('README');
  await expect(window.locator('.wm-modal-content li').first()).toContainText(
    'README.md',
  );
  await window.keyboard.press('Enter');

  // Editor panel 自动重建 + 显 README.md
  await expect(window.locator('header').first()).toContainText('README.md', {
    timeout: 10_000,
  });
  // EmptyState 消失
  await expect(
    window.locator('[data-testid="empty-state"]'),
  ).toBeHidden({ timeout: 5_000 });
});
