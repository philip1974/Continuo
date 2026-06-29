// 快捷键 Settings tab:列表 + 编辑 modal.
import { test, expect } from './fixtures/electron-app';
import { KEYBINDINGS_TAB, openSettingsTab } from './helpers/settings';

const KEYBINDINGS_TOTAL =
  /(共\s*\d+\s*个有快捷键的命令|\d+\s*commands with hotkey|단축키가 있는 명령어\s*\d+개)/;
const EDIT_HOTKEY = /编辑.*快捷键|Edit hotkey|단축키 편집/;
const RESET_DEFAULT_ARIA =
  'button[aria-label*="恢复默认"], button[aria-label*="default"], button[aria-label*="기본값"]';
const SEARCH_COMMANDS = /^(搜索命令名|Search commands|명령어)/;
const NO_MATCHING_COMMAND = /^(无匹配命令|No matching command|일치하는 명령어 없음)$/;

test('快捷键 tab 列出有 hotkey 的命令 + 计数', async ({ window }) => {
  await openSettingsTab(window, KEYBINDINGS_TAB);

  // 「共 N 个有快捷键的命令」
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
