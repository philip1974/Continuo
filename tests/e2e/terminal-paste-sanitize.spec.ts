// 安全(pastejacking):向终端粘贴含伪造 bracketed paste 结束标记的文本,PTY 侧只能在末尾
// 见到一个 \x1b[201~。走真实路径:Electron clipboard 写入 + webContents.paste()(即应用菜单
// Edit → Paste / Cmd+V 的 role:'paste')。shell 里 `cat -v` 把收到的字节可视化写入文件再断言。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/with-workspace';
import { TERMINAL_INPUT } from './helpers/editor';
import { dockHeaderMoreActionsButton } from './helpers/explorer';
import { TERMINAL_TAB } from './helpers/settings';

test('粘贴含 \\x1b[201~ 的文本 → PTY 收到的结束标记只在末尾', async ({
  window,
  electronApp,
  workspaceRoot,
}) => {
  await dockHeaderMoreActionsButton(window).click();
  const menu = window.getByRole('menu').last();
  await menu.getByRole('menuitem', { name: TERMINAL_TAB }).click();
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();

  const outFile = path.join(workspaceRoot, 'paste-out.txt');
  // 开 bracketed paste 模式后用 cat -v 记录原始输入(ESC 显示为 ^[)。
  await window.keyboard.type(`printf '\\033[?2004h'; cat -v > '${outFile}'`);
  await window.keyboard.press('Enter');
  await expect.poll(() => existsSync(outFile), { timeout: 15_000 }).toBe(true);

  await electronApp.evaluate(({ clipboard, BrowserWindow }) => {
    clipboard.writeText('ls\x1b[201~echo PWNED\r');
    const win = BrowserWindow.getAllWindows().find((w) => w.isFocused()) ?? BrowserWindow.getAllWindows()[0];
    win?.webContents.paste();
  });
  await window.keyboard.press('Enter');
  await window.keyboard.press('Control+D');

  await expect
    .poll(() => readFileSync(outFile, 'utf8'), { timeout: 15_000 })
    .toContain('^[[201~');
  const out = readFileSync(outFile, 'utf8');
  expect(out).toContain('^[[200~ls[201~echo PWNED');
  expect(out.split('^[[201~').length - 1).toBe(1);
});
