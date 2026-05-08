// keybinding tab 计数随动态注册带 hotkey 命令变化.
import { test, expect } from './fixtures/electron-app';

test('register e2e.X(hotkey)→ keybindings tab 计数 +1', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 打开 Settings → 快捷键 tab
  await window.locator('button[title="设置"]').click();
  await window
    .locator('nav[aria-label="设置分类"]')
    .getByRole('button', { name: '快捷键', exact: true })
    .click();

  await expect(
    window.locator('text=/共\\s*\\d+\\s*个有快捷键的命令/'),
  ).toBeVisible({ timeout: 10_000 });

  const before = await window
    .locator('text=/共\\s*\\d+\\s*个有快捷键的命令/')
    .first()
    .textContent();
  const beforeNum = Number(before?.match(/(\d+)/)?.[1] ?? '0');

  // register
  await window.evaluate(() => {
    const t = (
      window as unknown as {
        __continuoTest: {
          registerCommand: (
            id: string,
            title: string,
            hotkey?: string,
          ) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.kbd-count', 'KbdCount', 'mod+alt+z');
  });

  // 计数 +1
  await expect(async () => {
    const after = await window
      .locator('text=/共\\s*\\d+\\s*个有快捷键的命令/')
      .first()
      .textContent();
    const afterNum = Number(after?.match(/(\d+)/)?.[1] ?? '0');
    expect(afterNum).toBe(beforeNum + 1);
  }).toPass({ timeout: 5_000 });
});
