// Settings 资源管理器 tab 含 显示隐藏文件 + 缩进宽度 setting.
import { test, expect } from './fixtures/electron-app';
import {
  EXPLORER_TAB,
  INDENT_WIDTH_SETTING,
  SETTINGS,
  SETTINGS_NAV,
  SHOW_HIDDEN_FILES_SETTING,
} from './helpers/settings';

test('资源管理器 tab 显 showHiddenFiles + indentSize', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EXPLORER_TAB })
    .click();

  const main = window.locator('main');
  await expect(window.getByText(SHOW_HIDDEN_FILES_SETTING)).toBeVisible();
  await expect(window.getByText(INDENT_WIDTH_SETTING)).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'explorer.showHiddenFiles' }),
  ).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'explorer.indentSize' }),
  ).toBeVisible();
});
