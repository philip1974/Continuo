// SettingItemRow reset 按钮 title 含「恢复默认(${default})」.
import { test, expect } from './fixtures/electron-app';

test('改 fontSize → reset 按钮 title 含 default 值', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  // 改 fontSize 触发 override
  const fontInput = window.locator('input[type=number]').first();
  await fontInput.fill('15');

  // reset 按钮 title 含 'editor.fontSize 默认值 13'(默认值会出现在 title)
  // 实际 title 是 `恢复默认(${spec.default})`,所以含数字 13
  const resetBtn = window.locator('button[aria-label="恢复默认"]').first();
  const t = await resetBtn.getAttribute('title');
  expect(t).toContain('恢复默认');
  expect(t).toContain('13');
});
