// general.theme = light → reset → 默认 dark → html.dark 重加.
import { test, expect } from './fixtures/electron-app';

test('改 theme=light → reset → html 重新加 .dark', async ({ window }) => {
  // 默认 dark
  await expect(window.locator('html')).toHaveClass(/dark/);

  // 切到 light
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  const lightBtn = window
    .locator('button, [role=tab]')
    .filter({ hasText: /^Light$/i });
  await lightBtn.first().click();
  await expect(window.locator('html')).not.toHaveClass(/dark/, {
    timeout: 5_000,
  });

  // 同行 reset 按钮(此时 visible because override default)
  await window.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="恢复默认"]',
      ),
    ).find((b) => !b.className.includes('invisible'));
    btn?.click();
  });

  // theme 回 dark
  await expect(window.locator('html')).toHaveClass(/dark/, { timeout: 5_000 });
});
