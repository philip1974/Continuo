// 首次打开 Settings → 默认 active tab = 通用(priority=1).
import { test, expect } from './fixtures/electron-app';

test('打开 Settings → 通用 button 高亮(border-accent)', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  const nav = window.locator('nav[aria-label="设置分类"]');
  await expect(nav).toBeVisible({ timeout: 10_000 });

  const generalBtn = nav.getByRole('button', { name: '通用', exact: true });
  await expect(generalBtn).toHaveAttribute('class', /border-accent/);

  // 主区显主题 setting(general 类)
  await expect(window.locator('main')).toContainText('主题');
});
