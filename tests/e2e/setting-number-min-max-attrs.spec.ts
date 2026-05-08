// editor.fontSize input min=10/max=28/step=1 → DOM 属性.
import { test, expect } from './fixtures/electron-app';

test('editor.fontSize input min/max/step 属性渲染', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: '编辑器', exact: true }).click();

  const input = window.locator('input[type=number]').first();
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('min', '10');
  await expect(input).toHaveAttribute('max', '28');
  await expect(input).toHaveAttribute('step', '1');
});
