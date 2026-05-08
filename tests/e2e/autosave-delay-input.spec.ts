// autoSave.delayMs input 默认 2000 + 改后 store 同步.
import { test, expect } from './fixtures/electron-app';

test('编辑器 tab 第二 number input = 2000 + 改后 store=4000', async ({
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

  // 第一个 input(fontSize)+ 第二个(autoSave.delayMs)
  const inputs = window.locator('input[type=number]');
  await expect(inputs.nth(1)).toHaveValue('2000');

  await inputs.nth(1).fill('4000');
  await expect(inputs.nth(1)).toHaveValue('4000');

  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  const v = await window.evaluate(
    () =>
      (
        window as unknown as {
          __continuoTest: { getSettingValue: (id: string) => unknown };
        }
      ).__continuoTest.getSettingValue('autoSave.delayMs'),
  );
  expect(v).toBe(4000);
});
