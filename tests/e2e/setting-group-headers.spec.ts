// SettingItemSpec.group 字段 → CategoryTabContent 渲染 h3 group header.
// 编辑器 tab 内有「外观」「自动保存」两组 + 默认 bucket(无 header).
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab 显示「外观」「自动保存」group h3 header', async ({
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

  // h3 集合中包含「外观」「自动保存」
  const headers = window.locator('main h3');
  await expect(headers.filter({ hasText: '外观' })).toBeVisible();
  await expect(headers.filter({ hasText: '自动保存' })).toBeVisible();
});
