// fresh userData → settings input 显示 spec.default(13 / true 等).
import { test, expect } from './fixtures/electron-app';

test('打开 Settings 编辑器 → fontSize input value=13(默认)', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  // editor.fontSize default=13
  await expect(window.locator('input[type=number]').first()).toHaveValue('13');
  // editor.lineNumbers default=true
  const lineNumbers = window.locator('button[role=switch]').first();
  await expect(lineNumbers).toHaveAttribute('aria-checked', 'true');
});
