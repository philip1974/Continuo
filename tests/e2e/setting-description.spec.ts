// SettingItemRow 显示 description 文本(若 spec.description 存在).
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab 显示 fontSize description「CodeEditor 字号」之类', async ({
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

  // 验证有 description 文案存在(EditorTabPlugin 注册了 description)
  const main = window.locator('main');
  await expect(main).toContainText('字号');
  // 自动保存说明
  await expect(main).toContainText('Markdown');
  await expect(main).toContainText('代码');
});

test('终端 tab 显示 fontSize description', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '终端', exact: true })
    .click();

  // TerminalTabPlugin 注册了 fontSize description 'xterm 字号。变化时自动 fit 重排。'
  await expect(window.locator('main')).toContainText('xterm');
});
