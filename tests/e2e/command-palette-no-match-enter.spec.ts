// CommandPalette 无匹配时按 Enter → 无 cmd 可执行,modal 仍开 + 不抛.
import { test, expect } from './fixtures/electron-app';
import { SETTINGS } from './helpers/settings';
import { COMMAND_SEARCH } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const NO_MATCH = /^(无匹配命令|No matching command|일치하는 명령어 없음)$/;

test('无匹配时 Enter → modal 仍开 + 不抛', async ({ window }) => {
  await expect(window.getByRole('button', { name: SETTINGS })).toBeVisible({
    timeout: 10_000,
  });

  await dispatchModKey(window, 'p', { shift: true });
  const dialog = window.getByRole('dialog', { name: COMMAND_SEARCH });
  const input = dialog.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();

  await input.fill('zzz_no_match_xx');
  await expect(dialog.getByRole('status').filter({ hasText: NO_MATCH })).toBeVisible();

  // Enter 不抛 + modal 不关(filtered[selectedIndex] 是 undefined)
  await window.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(input).toBeVisible();
});
