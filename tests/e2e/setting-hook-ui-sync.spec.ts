// SettingsPanel 打开时 setSettingValue → input value 同步.
import { test, expect } from './fixtures/electron-app';

test('SettingsPanel 显 + hook setValue → input 同步', async ({ window }) => {
  await window.locator('button[title="设置"]').click();
  await expect(window.locator('nav[aria-label="设置分类"]')).toBeVisible({
    timeout: 10_000,
  });
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '编辑器', exact: true })
    .click();

  const fontInput = window.locator('input[type=number]').first();
  await expect(fontInput).toHaveValue('13');

  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: number) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('editor.fontSize', 18);
  });

  await expect(fontInput).toHaveValue('18', { timeout: 3_000 });
});
