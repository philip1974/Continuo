// 命令面板 recent:执行某命令后,下次空 query 时该命令置顶.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS } from './helpers/settings';
import { COMMAND_SEARCH, COMMAND_LIST } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const SETTINGS_TITLE = /(切换设置|Toggle Settings|설정 토글)/;

test('执行 settings.toggle → 关 + 重开 → recent 第一项是 Settings 相关', async ({
  window,
}) => {
  const settingsButton = window.getByRole('button', { name: SETTINGS });
  await expect(settingsButton).toBeVisible({ timeout: 10_000 });
  const settingsQuery =
    (await settingsButton.getAttribute('title'))?.toLocaleLowerCase() ??
    'settings';

  // 第一次:搜 Settings 命令执行
  await dispatchModKey(window, 'p', { shift: true });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();
  await input.fill(settingsQuery);
  const settingsCommand = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: SETTINGS_TITLE });
  await expect(settingsCommand).toBeVisible();
  await settingsCommand.click();
  await expect(input).toBeHidden();

  // 第二次:打开命令面板,空 query 时第一项应是刚才执行的命令
  await dispatchModKey(window, 'p', { shift: true });
  await expect(input).toBeVisible();
  // 第一项 li 含 「Settings」(category 或 title)
  const firstItem = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .first();
  await expect(firstItem).toContainText(SETTINGS_TITLE);

  await window.keyboard.press('Escape');
});
