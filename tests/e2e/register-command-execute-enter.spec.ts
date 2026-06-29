// 动态注册的命令 + Enter 在 palette 中执行 → modal 关闭(fn 是 noop).
import { test, expect } from './fixtures/electron-app';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';

test('动态命令 → palette → Enter → modal 关', async ({ window }) => {
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
          registerCommand: (id: string, title: string) => () => void;
        };
      }
    ).__continuoTest;
    t.registerCommand('e2e.execute-noop', 'ExecuteNoOp');
  });

  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  await expect(input).toBeVisible();
  await input.fill('ExecuteNoOp');

  const item = window.locator('.wm-modal-content li').first();
  await expect(item).toContainText('ExecuteNoOp');

  await window.keyboard.press('Enter');
  await expect(input).toBeHidden({ timeout: 5_000 });
});
