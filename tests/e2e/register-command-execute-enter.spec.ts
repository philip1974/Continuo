// 动态注册的命令 + Enter 在 palette 中选中 → modal 关闭。testing hook 注册的 fn 是空函数,本用例不验证命令是否真的执行。
import { test, expect } from './fixtures/electron-app';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

test('动态命令 → palette → Enter → modal 关', async ({ window }) => {
  await waitForTestHooks(window);

  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
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
