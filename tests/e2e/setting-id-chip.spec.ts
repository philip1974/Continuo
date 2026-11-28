// SettingItemRow 的 id chip(<code>):title 后紧贴显示 spec.id(保留原大小写,不 uppercase).
import { test, expect } from './fixtures/electron-app';
import {
  EDITOR_TAB,
  TERMINAL_TAB,
  openSettingsTab,
} from './helpers/settings';

test('编辑器 tab 内显示 setting id chip:editor.fontSize', async ({
  window,
}) => {
  await openSettingsTab(window, EDITOR_TAB);

  // chip 是 <code> 元素;查 main 内含 'editor.fontSize' 的 code
  const chip = window
    .locator('main code')
    .filter({ hasText: 'editor.fontSize' });
  await expect(chip).toBeVisible();
  // id 区分大小写:渲染出的文本不得被 CSS 大写化(innerText 反映 text-transform)
  expect(await chip.evaluate((el) => (el as HTMLElement).innerText)).toBe('editor.fontSize');
});

test('终端 tab 内显示 setting id chip:terminal.integrated.cursorStyle', async ({
  window,
}) => {
  await openSettingsTab(window, TERMINAL_TAB);

  const chip = window
    .locator('main code')
    .filter({ hasText: 'terminal.integrated.cursorStyle' });
  await expect(chip).toBeVisible();
});
