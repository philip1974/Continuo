// Settings 资源管理器 tab 含 显示隐藏文件 + 缩进宽度 setting.
import { test, expect } from './fixtures/electron-app';
import { EXPLORER_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('资源管理器 tab 显 showHiddenFiles + indentSize', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EXPLORER_TAB })
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
