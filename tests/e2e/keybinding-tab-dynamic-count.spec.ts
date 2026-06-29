// keybinding tab 计数随动态注册带 hotkey 命令变化.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';

const KEYBINDINGS_TOTAL =
  /(共\s*\d+\s*个有快捷键的命令|\d+\s*commands with hotkey|단축키가 있는 명령어\s*\d+개)/;

test('register e2e.X(hotkey)→ keybindings tab 计数 +1', async ({ window }) => {
  await window.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __continuoTest?: unknown }).__continuoTest,
      ),
    { timeout: 5_000 },
  );

  // 打开 Settings → 快捷键 tab
  await openSettingsTab(window, KEYBINDINGS_TAB);

  await expect(window.getByText(KEYBINDINGS_TOTAL)).toBeVisible({
    timeout: 10_000,
  });

  const before = await window
    .getByText(KEYBINDINGS_TOTAL)
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
      .getByText(KEYBINDINGS_TOTAL)
      .first()
      .textContent();
    const afterNum = Number(after?.match(/(\d+)/)?.[1] ?? '0');
    expect(afterNum).toBe(beforeNum + 1);
  }).toPass({ timeout: 5_000 });
});
