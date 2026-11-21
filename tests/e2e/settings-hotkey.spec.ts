// settings.toggle 命令的 hotkey ⌘, 真实触发 → 打开 SettingsPanel.
import { test, expect } from './fixtures/electron-app';
import { dispatchModKey } from './helpers/hotkeys';
import { SETTINGS, SETTINGS_NAV } from './helpers/settings';

test('Cmd/Ctrl+, → 打开 SettingsPanel', async ({ window }) => {
  // 等 app ready(useCommandHotkeys 挂载 + commands registry 注册 settings.toggle).
  // 用 IconSidebar 设置齿轮按钮可见作为就绪指标.
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await dispatchModKey(window, ',');

  await expect(window.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({
    timeout: 10_000,
  });
});
