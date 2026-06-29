// fontSize input(type=number)对字母输入容错:浏览器 native 已挡,setValue 不被 NaN 污染.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('fontSize input 改后 store 仍是合法数字', async ({ window }) => {
  await window.getByRole('button', { name: SETTINGS }).click();
  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
  await window
    .getByRole('navigation', { name: SETTINGS_NAV })
    .getByRole('button', { name: EDITOR_TAB })
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
