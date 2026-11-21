// editor.lineNumbers setting 切 false → CM .cm-editor 加 .cm-no-gutters.
import { test, expect } from './fixtures/with-workspace';

test('打开 a.ts → setting 改 lineNumbers=false → CM 加 cm-no-gutters', async ({
  window,
}) => {
  await window.locator('text=src').first().click();
  await window.locator('text=a.ts').first().click();
  const cm = window.locator('.cm-editor').first();
  await expect(cm).toBeVisible({ timeout: 10_000 });

  // 默认 lineNumbers=true → 不应有 cm-no-gutters
  await expect(cm).not.toHaveClass(/cm-no-gutters/);

  // 用 testing hook 改 setting
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
          setSettingValue: (id: string, v: boolean) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('editor.lineNumbers', false);
  });

  // CM 类 应同步加 cm-no-gutters
  await expect(cm).toHaveClass(/cm-no-gutters/, { timeout: 3_000 });
});
