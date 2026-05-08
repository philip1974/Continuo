// 改非主题设置(fontSize)+ 切 light → fontSize 仍是修改后值.
import { test, expect } from './fixtures/electron-app';

test('改 fontSize=18 + 切 light → fontSize 仍 18', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await nav.getByRole('button', { name: '编辑器', exact: true }).click();

  await window.locator('input[type=number]').first().fill('18');

  // 切 light
  await nav.getByRole('button', { name: '通用', exact: true }).click();
  await window
    .locator('button, [role=tab]')
    .filter({ hasText: /^Light$/i })
    .first()
    .click();
  await expect(window.locator('html')).not.toHaveClass(/dark/);

  // 回编辑器 tab → fontSize 仍 18
  await nav.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(window.locator('input[type=number]').first()).toHaveValue('18');
});
