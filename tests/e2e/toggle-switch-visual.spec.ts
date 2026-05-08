// ToggleSwitch checked=true → class 含 bg-accent;false → bg-panel-soft.
import { test, expect } from './fixtures/electron-app';

test('显示行号 toggle: 默认 bg-accent → 切 false → bg-panel-soft', async ({
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

  const toggle = window.locator('button[role=switch]').first();
  await expect(toggle).toHaveClass(/bg-accent/);

  await toggle.click();
  await expect(toggle).toHaveClass(/bg-panel-soft/, { timeout: 3_000 });
  await expect(toggle).not.toHaveClass(/bg-accent/);
});
