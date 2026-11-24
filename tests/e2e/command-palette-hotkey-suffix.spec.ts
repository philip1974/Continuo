// CommandPalette 列表项右侧显示 hotkey 后缀(KeyCap 切片).
import { test, expect } from './fixtures/electron-app';
import { SETTINGS } from './helpers/settings';
import { COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const SETTINGS_TITLE = /(切换 Settings|Toggle Settings|설정 토글)/;

test('settings.toggle 行右侧显示 hotkey 切片', async ({ window }) => {
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({ timeout: 10_000 });
  const settingsQuery =
    (await settingsButton.getAttribute('title'))?.toLocaleLowerCase() ??
    'settings';

  await dispatchModKey(window, 'p', { shift: true });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  await input.fill(settingsQuery);
  const settingsOption = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_TITLE });
  await expect(settingsOption).toBeVisible();

  // KeyCap 切片(formatHotkeyParts):mac 平台 ⌘ + ',';others Ctrl + ','
  // 不 platform-assume,只验证有 KeyCap kbd 元素
  const kbds = settingsOption.locator('kbd.wm-keycap');
  expect(await kbds.count()).toBeGreaterThan(0);
});
