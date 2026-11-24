// palette 开后注册新命令 → 列表立即含(commands.subscribe).
import { test, expect } from './fixtures/electron-app';
import { COMMAND_NO_MATCH, commandPaletteInput, openCommandPalette } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

test('palette 开 → register e2e.live → 列表立即含', async ({ window }) => {
  await waitForTestHooks(window);

  // 开 palette
  await openCommandPalette(window);
  const input = commandPaletteInput(window);
  // 输预期不存在的字符串
  await input.fill('LiveRegistered');
  await expect(window.locator('.wm-modal-content')).toContainText(COMMAND_NO_MATCH);

  // 注册命令
  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    t.registerCommand('e2e.live', 'LiveRegistered Cmd');
  });

  // 列表应立即更新 → 含命令
  await expect(window.locator('.wm-modal-content li').first()).toContainText('LiveRegistered', {
    timeout: 3_000,
  });
});
