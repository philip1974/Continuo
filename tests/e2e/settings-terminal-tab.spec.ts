// Settings 终端 tab 含字号 + 光标样式 + id chip.
import { test, expect } from './fixtures/electron-app';

test('终端 tab 显字号(terminal.fontSize)+ 光标样式(terminal.cursorStyle)', async ({
  window,
}) => {
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '终端', exact: true })
    .click();

  const main = window.locator('main');
  await expect(main).toContainText('字号');
  await expect(main).toContainText('光标样式');
  await expect(
    main.locator('code').filter({ hasText: 'terminal.fontSize' }),
  ).toBeVisible();
  await expect(
    main.locator('code').filter({ hasText: 'terminal.cursorStyle' }),
  ).toBeVisible();
});
