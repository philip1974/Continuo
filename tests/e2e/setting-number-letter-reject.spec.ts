// fontSize input(type=number)对字母输入容错:浏览器 native 挡掉字母,setValue 不被 NaN 污染;合法数字照常写入 store.
import { test, expect } from './fixtures/electron-app';
import { EDITOR_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('fontSize input 键入字母被拒、store 仍为合法数字;键入数字照常写入', async ({ window }) => {
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

  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  const readStored = () =>
    window.evaluate(
      () =>
        (
          window as unknown as {
            __continuoTest: { getSettingValue: (id: string) => unknown };
          }
        ).__continuoTest.getSettingValue('editor.fontSize'),
    );

  // 键入字母:number input 不接受(fill 字母串会直接抛错,故用真实键入)
  await input.click();
  await window.keyboard.type('abc');
  await expect(input).toHaveValue('13');
  // getSettingValue 读的是已存储值(未覆盖时为 undefined):字母未写入任何值(不被 NaN 污染)
  expect(await readStored()).toBeUndefined();

  // 输 16(合法数字)
  await input.fill('16');
  await expect(input).toHaveValue('16');

  // 通过 testing hook 取 store value
  await expect.poll(readStored).toBe(16);
});
