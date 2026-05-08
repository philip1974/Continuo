// Boolean SettingItem 用 ToggleSwitch(role=switch) 实现.
// 切换 + reset 按钮可见性同步.
import { test, expect } from './fixtures/electron-app';

test('editor.lineNumbers 切换 → aria-checked 同步 + reset 可见', async ({
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

  // 找「显示行号」行的 toggle(aria-checked='true' 是默认)
  const row = window.locator('main').getByText('显示行号').locator('..');
  // 行内的 ToggleSwitch
  const toggle = window.locator('button[role=switch]').first();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // 切换 → false
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // 同行 reset 按钮可见(不再 invisible)
  await expect(
    row.locator('xpath=..').locator('button[aria-label=恢复默认]'),
  ).toBeVisible();
});
