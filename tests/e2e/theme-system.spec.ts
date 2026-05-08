// theme=system → 跟随 prefers-color-scheme:emulate light → html.dark 摘掉.
import { test, expect } from './fixtures/electron-app';

test('theme=system + emulate light → html 移除 dark; 切 dark media → html 加 dark', async ({
  window,
}) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 设 setting=system
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          setSettingValue: (id: string, v: string) => void;
        };
      }
    ).__continuoTest;
    t.setSettingValue('general.theme', 'system');
  });

  // emulate light → html.dark 移除
  await window.emulateMedia({ colorScheme: 'light' });
  await expect(window.locator('html')).not.toHaveClass(/dark/, {
    timeout: 5_000,
  });

  // emulate dark → html 加 dark
  await window.emulateMedia({ colorScheme: 'dark' });
  await expect(window.locator('html')).toHaveClass(/dark/, { timeout: 5_000 });
});
