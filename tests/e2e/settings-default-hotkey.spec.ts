// 默认 hotkey ⌘+, → 打开 Settings panel.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS_NAV } from './helpers/settings';
import { waitForTestHooks } from './helpers/app-ready';

test('Mod+, → Settings nav 出现', async ({ window }) => {
  // 等命令面板 commands 注册到位 + listener 挂上
  await waitForTestHooks(window);
  await window.waitForTimeout(500);

  await window.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ',',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
