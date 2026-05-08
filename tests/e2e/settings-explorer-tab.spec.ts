// Settings 资源管理器 tab 含 显示隐藏文件 + 缩进宽度 setting.
import { test, expect } from './fixtures/electron-app';

test('资源管理器 tab 显 showHiddenFiles + indentSize', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '资源管理器', exact: true })
    .click();

  const main = window.locator('main');
  await expect(main).toContainText('显示隐藏文件');
  await expect(main).toContainText('缩进宽度');
  await expect(
    main.locator('code').filter({ hasText: 'explorer.showHiddenFiles' }),
  ).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'explorer.indentSize' }),
  ).toBeVisible();
});
