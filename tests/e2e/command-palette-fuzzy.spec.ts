// CommandPalette fuzzy 匹配 — 本地化标签 + 跨字符匹配.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS } from './helpers/settings';
import { COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const SETTINGS_TITLE = /(切换设置|Toggle Settings|설정 토글)/;

function sparseSettingsQuery(settingsLabel: string): string {
  if (settingsLabel === '설정') return '설토';
  if (settingsLabel === '设置') return '设s';
  return 'ss';
}

test('本地化 Settings 查询能匹配 settings.toggle 命令', async ({
  window,
}) => {
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({
    timeout: 10_000,
  });

  const settingsQuery =
    (await settingsButton.getAttribute('aria-label'))?.toLocaleLowerCase() ??
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
});

test('跨字符模糊查询匹配 settings.toggle 命令', async ({ window }) => {
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({
    timeout: 10_000,
  });
  const settingsLabel = (await settingsButton.getAttribute('aria-label')) ?? 'Settings';

  await dispatchModKey(window, 'p', { shift: true });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  const settingsOption = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_TITLE });
  await expect(settingsOption).toBeVisible();

  await input.fill(sparseSettingsQuery(settingsLabel));
  await expect(settingsOption).toBeVisible();
});
