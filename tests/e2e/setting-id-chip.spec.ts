// SettingItemRow 的 id chip(<code>):title 后紧贴显示 spec.id(uppercase 样式).
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab 内显示 setting id chip:editor.fontSize', async ({
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

  // chip 是 <code> 元素;查 main 内含 'editor.fontSize' 的 code
  const chip = window
    .locator('main code')
    .filter({ hasText: 'editor.fontSize' });
  await expect(chip).toBeVisible();
});

test('终端 tab 内显示 setting id chip:terminal.cursorStyle', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '终端', exact: true })
    .click();

  const chip = window
    .locator('main code')
    .filter({ hasText: 'terminal.cursorStyle' });
  await expect(chip).toBeVisible();
});
