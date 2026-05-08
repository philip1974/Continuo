// fontSize input(type=number)对字母输入容错:浏览器 native 已挡,setValue 不被 NaN 污染.
import { test, expect } from './fixtures/electron-app';

test('fontSize input 改后 store 仍是合法数字', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  const input = window.locator('input[type=number]').first();
  await expect(input).toHaveValue('13');

  // 输 16(合法数字)
  await input.fill('16');
  await expect(input).toHaveValue('16');

  // 通过 testing hook 取 store value
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  const stored = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { getSettingValue: (id: string) => unknown };
        }
      ).__continuoTest.getSettingValue('editor.fontSize'),
  );
  expect(stored).toBe(16);
});
