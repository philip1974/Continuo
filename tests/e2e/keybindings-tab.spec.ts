// 快捷键 Settings tab:列表 + 编辑 modal.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';
import { COMMAND_LIST, COMMAND_SEARCH } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const KEYBINDINGS_TOTAL =
  /(共\s*\d+\s*个命令[,，]\d+\s*个已绑定|\d+\s*commands, \d+ bound|명령어\s*\d+개, \d+개 바인딩됨)/;
const EDIT_HOTKEY = /编辑.*快捷键|Edit hotkey|단축키 편집/;
const RESET_DEFAULT_ARIA =
  'button[aria-label*="恢复默认"], button[aria-label*="default"], button[aria-label*="기본값"]';
const SEARCH_COMMANDS = /^(搜索命令名|Search commands|명령어)/;
const NO_MATCHING_COMMAND = /^(无匹配命令|No matching command|일치하는 명령어 없음)$/;

test('快捷键 tab 列出全部命令 + 计数', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);

  // 「共 N 个命令，M 个已绑定」
  await expect(window.getByText(KEYBINDINGS_TOTAL)).toBeVisible({
    timeout: 10_000,
  });

  // 至少有一个命令行(li)
  await expect(window.locator('main li').first()).toBeVisible();
});

test('每条命令行有「编辑快捷键」按钮 + 「恢复默认」占位', async ({
  window,
}) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  // 等列表渲染
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });

  // 至少有一个 编辑快捷键 按钮
  const editBtns = window.getByRole('button', { name: EDIT_HOTKEY });
  expect(await editBtns.count()).toBeGreaterThan(0);
  // 也至少有一个 恢复默认 按钮(invisible 但 DOM 存在)
  const resetBtns = window.locator(RESET_DEFAULT_ARIA);
  expect(await resetBtns.count()).toBeGreaterThan(0);
});

test('搜索过滤命令(只显匹配项)', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  await expect(window.locator('main li').first()).toBeVisible({
    timeout: 10_000,
  });

  const initial = await window.locator('main li').count();

  const search = window.getByRole('textbox', { name: SEARCH_COMMANDS });
  await search.fill('zzz_no_match_xx');
  await expect(window.getByText(NO_MATCHING_COMMAND)).toBeVisible();

  await search.fill('');
  await expect(window.locator('main li')).toHaveCount(initial);
});

// 保留键归属命令(src/__tests__/reserved-command-hotkeys):转到文件… 显示 ⌘P(Ctrl+P),标「保留键，不可更改」,编辑按钮禁用。
const GO_TO_FILE_QUERY = 'file';

test('转到文件… 行显示 ⌘P + 保留键不可更改,编辑按钮禁用;命令面板显示 ⌘P', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);
  const edit = window.locator('[data-keybinding-edit="workbench.action.quickOpen"]');
  await expect(edit).toBeDisabled({ timeout: 10_000 });
  const row = window.locator('main li').filter({ has: edit });
  const keys = process.platform === 'darwin' ? '⌘P' : 'CtrlP';
  await expect(row.getByTestId('keybinding-keys')).toHaveText(keys);
  await expect(row).toContainText(/保留键，不可更改|Reserved — cannot be changed|예약된 키, 변경할 수 없음/);
  await expect(row).not.toContainText(/未绑定|Unbound|바인딩 없음/);

  await dispatchModKey(window, 'p', { shift: true });
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();
  await input.fill(GO_TO_FILE_QUERY);
  const option = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: /转到文件|Go to File|파일로 이동/ });
  await expect(option.first()).toBeVisible();
  await expect(option.first().locator('kbd.wm-keycap')).toHaveText(process.platform === 'darwin' ? ['⌘', 'P'] : ['Ctrl', 'P']);
});
