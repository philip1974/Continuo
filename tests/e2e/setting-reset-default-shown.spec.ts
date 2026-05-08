// 改 fontSize=22 → reset → input value 回到 default 13.
import { test, expect } from './fixtures/electron-app';

test('改 fontSize=22 → reset → input value=13', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('22');
  await expect(fontInput).toHaveValue('22');

  // 点 visible reset
  await window.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="恢复默认"]',
      ),
    ).find((b) => !b.className.includes('invisible'));
    btn?.click();
  });

  await expect(fontInput).toHaveValue('13');
});
