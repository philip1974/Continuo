// registerCommand + hotkey → CommandPalette 列表项右侧 KeyCap kbd 显示.
import { test, expect } from './fixtures/electron-app';
import { COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';
import { waitForTestHooks } from './helpers/app-ready';

test('动态注册命令 + hotkey → palette 显 KeyCap', async ({ window }) => {
  await waitForTestHooks(window);

  await window.evaluate(() => {
    const t = globalThis.__continuoTest!;
    // 选一个没有内置命令占用的组合:被别的命令占用(如 mod+shift+t = 重新打开已关闭的编辑器)时键位按冲突落败不显示
    t.registerCommand('e2e.kbd-display', 'KbdDisplay Test', 'mod+alt+shift+y');
  });

  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        // 平台主修饰键:mac = Cmd,其它 = Ctrl(mac 上面板热键只认 Cmd)
        ctrlKey: !navigator.platform.toLowerCase().includes('mac'),
        metaKey: navigator.platform.toLowerCase().includes('mac'),
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible({ timeout: 5_000 });

  await input.fill('KbdDisplay');
  const item = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: 'KbdDisplay Test' });
  await expect(item).toBeVisible();

  // 该项右侧有 ≥ 1 个 kbd.wm-keycap(formatHotkeyParts)
  const kbds = item.locator('kbd.wm-keycap');
  expect(await kbds.count()).toBeGreaterThan(0);
  await expect(kbds.last()).toHaveText('Y');
});
