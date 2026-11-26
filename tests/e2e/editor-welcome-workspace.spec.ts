// EditorWelcome(有工作区):VSCode 有工作区时的空编辑区水印同样列 Find in Files / Toggle Terminal —— 首次使用时全局搜索与
// 终端也有入口。顺序:转到文件 ⌘P → 在文件中查找 ⇧⌘F → 新建终端 ⌘T → 显示所有命令 ⇧⌘P。BDD: src/__tests__/editor-welcome/
import { test, expect } from './fixtures/with-workspace';
import { EDITOR_NO_FILE_OPEN } from './helpers/editor';

const WELCOME_FIND = /^(在文件中查找|Find in Files|파일에서 찾기)/;
const WELCOME_TERMINAL = /^(新建终端|New Terminal|새 터미널)/;
const QUERY = /^(搜索|Search|검색)$/;

test('有工作区 → 列「在文件中查找 ⇧⌘F」「新建终端 ⌘T」;点「在文件中查找」打开搜索面板并聚焦查询框', async ({ window }) => {
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 10_000 });
  const main = window.locator('main');
  const actions = main.locator('[data-welcome-action]');
  await expect(actions).toHaveCount(4);
  expect(await actions.evaluateAll((els) => els.map((e) => e.getAttribute('data-welcome-action')))).toEqual([
    'quick-open',
    'find-in-files',
    'new-terminal',
    'show-commands',
  ]);
  const find = main.locator('[data-welcome-action="find-in-files"]');
  const terminal = main.locator('[data-welcome-action="new-terminal"]');
  await expect(find).toHaveAccessibleName(WELCOME_FIND);
  await expect(find.locator('kbd.wm-keycap')).toHaveText(['⇧', '⌘', 'F']);
  await expect(terminal).toHaveAccessibleName(WELCOME_TERMINAL);
  await expect(terminal.locator('kbd.wm-keycap')).toHaveText(['⌘', 'T']);

  await find.click();
  await expect(window.getByRole('textbox', { name: QUERY })).toBeFocused({ timeout: 10_000 });
});
