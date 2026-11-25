// EditorWelcome(编辑区无 tab):VSCode 空编辑区水印式的下一步入口。无工作区 →「打开文件夹 ⌘O」「显示所有命令 ⇧⌘P」,
// 每项是可聚焦按钮;不再提示「在资源管理器中单击文件打开」。BDD: src/__tests__/editor-welcome/
import { test, expect } from './fixtures/electron-app';
import { EDITOR_NO_FILE_OPEN } from './helpers/editor';
import { COMMAND_SEARCH } from './helpers/palette';

const WELCOME_OPEN_FOLDER = /^(打开文件夹|Open Folder|폴더 열기)/;
const WELCOME_SHOW_COMMANDS = /^(显示所有命令|Show All Commands|모든 명령 표시)/;

test('启动后(无工作区)→ EditorWelcome 显示「打开文件夹 ⌘O」「显示所有命令 ⇧⌘P」按钮', async ({ window }) => {
  await expect(window.getByText(EDITOR_NO_FILE_OPEN).first()).toBeVisible({ timeout: 5_000 });
  const main = window.locator('main');
  const openFolder = main.locator('[data-welcome-action="open-folder"]');
  const showCommands = main.locator('[data-welcome-action="show-commands"]');
  await expect(openFolder).toBeVisible();
  await expect(openFolder).toHaveAccessibleName(WELCOME_OPEN_FOLDER);
  await expect(openFolder.locator('kbd.wm-keycap')).toHaveText(['⌘', 'O']);
  await expect(showCommands).toHaveAccessibleName(WELCOME_SHOW_COMMANDS);
  await expect(showCommands.locator('kbd.wm-keycap')).toHaveText(['⇧', '⌘', 'P']);
  await expect(main).not.toContainText(/单击文件打开|Click a file in Explorer/);

  // 键盘可达:聚焦后 Enter 打开命令面板
  await showCommands.focus();
  await window.keyboard.press('Enter');
  await expect(window.getByRole('combobox', { name: COMMAND_SEARCH })).toBeVisible();
});
