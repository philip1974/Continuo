// 终端交互对齐 VSCode(BDD:src/__tests__/terminal-vscode-parity):进程退出、关闭确认、⌘K 清屏。
// 走真实 PTY:terminal.new 命令建会话,键盘输入 shell 命令;终端文字经测试钩子读缓冲区(WebGL 渲染时 DOM 里没有文字)。
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';

async function newTerminal(window: Page) {
  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  const byName = window.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  await expect(byName).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  // 之后按面板 id 找:运行前台程序时 tab 标题会变成程序名(terminal-title)。
  const tab = window.locator(`[role=tab][data-panel-id="${await byName.getAttribute('data-panel-id')}"]`);
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  // 等提示符出现(shell 就绪)再键入
  await expect
    .poll(() => window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? ''), { timeout: 15_000 })
    .not.toBe('');
  return tab;
}

const terminalText = (window: Page) =>
  window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');

async function run(window: Page, command: string) {
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

test('exit 1:终端内显示退出说明,之后按键不再报错,任意键关闭', async ({ window }) => {
  const tab = await newTerminal(window);
  await run(window, 'exit 1');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toMatch(/exit code: 1|退出代码：1|종료 코드: 1/);
  await expect(tab).toHaveText(/\((exited|已退出|종료됨)\)/);
  // 非「任意键」的方向键:此前会发 IPC → NOT_FOUND 错误 toast;现在不再发
  await window.keyboard.press('ArrowUp');
  await window.waitForTimeout(500);
  await expect(window.locator('.toast[data-level="error"]')).toHaveCount(0);
  await window.keyboard.press('a');
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(0, { timeout: 5_000 });
});

test('exit 0:终端面板自动关闭', async ({ window }) => {
  await newTerminal(window);
  await run(window, 'exit 0');
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(0, { timeout: 15_000 });
  await expect(window.locator('.toast[data-level="error"]')).toHaveCount(0);
});

test('运行 sleep 30 时关闭 tab → 弹终止确认;取消保留,终止后关闭', async ({ window }) => {
  const tab = await newTerminal(window);
  await run(window, 'sleep 30');
  // 等 sleep 成为前台进程(tab 标题随之变成进程名)
  await expect(tab).toContainText('sleep', { timeout: 5_000 });
  const close = tab.getByRole('button');
  await close.last().click();
  const dialog = window.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  // 标题就是进程名 → 只写进程名,不写「「sleep」中的「sleep」」
  await expect(dialog).toContainText(/(“sleep” is still running\.|「sleep」仍在运行|"sleep"이\(가\) 아직 실행 중)/);
  await expect(dialog).not.toContainText(/( in “sleep”|「sleep」中的|"sleep"에서)/);
  await dialog.getByRole('button', { name: /^(Cancel|取消|취소)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(tab).toBeVisible();

  await close.last().click();
  await window.getByRole('alertdialog').getByRole('button', { name: /^(Terminate|终止|종료)$/ }).click();
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(0, { timeout: 5_000 });
});

test('只有 shell 时关闭 tab 不确认', async ({ window }) => {
  const tab = await newTerminal(window);
  await tab.getByRole('button').last().click();
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(0, { timeout: 5_000 });
  await expect(window.getByRole('alertdialog')).toHaveCount(0);
});

// terminal.clear 默认键同 VSCode 只 mac 有(⌘K);Win/Linux 无默认键,Ctrl+K 进 shell(见 skip-shell-hotkeys 规范)。
test('mac:⌘K 清空屏幕与滚动缓冲', async ({ window }) => {
  test.skip(process.platform !== 'darwin', 'terminal.clear 仅 mac 有默认键');
  await newTerminal(window);
  await run(window, 'for i in $(seq 1 200); do echo line-$i; done');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('line-200');
  await window.keyboard.press('Meta+KeyK');
  await expect.poll(() => terminalText(window), { timeout: 5_000 }).not.toContain('line-200');
  expect(await terminalText(window)).not.toContain('line-1');
});

// 新建终端后焦点直接进 xterm(VSCode):焦点在编辑器时 ⌘T / Ctrl+T 后无需点击即可键入(BDD:dock-terminal-vscode-focus 第 2 条)。
test('焦点在编辑器时 mod+T 新建终端 → 直接键入进终端', async ({ window }) => {
  await waitForTestHooks(window);
  const readme = window.locator('text=README.md').first();
  await expect(readme).toBeVisible({ timeout: 10_000 });
  await readme.click();
  const editable = window.locator('[contenteditable="true"]').first();
  await expect(editable).toBeVisible({ timeout: 10_000 });
  await editable.click();
  await expect.poll(() => window.evaluate(() => document.activeElement?.closest('[contenteditable="true"]') !== null)).toBe(true);

  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyT' : 'Control+KeyT');
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveAttribute('aria-selected', 'true', {
    timeout: 15_000,
  });
  // 不手动 focus:焦点应已在 xterm 输入框
  await expect(window.getByRole('textbox', { name: TERMINAL_INPUT })).toBeFocused({ timeout: 15_000 });
  await expect
    .poll(() => terminalText(window), { timeout: 15_000 })
    .not.toBe('');
  await run(window, 'echo focus-$((40+2))');
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).toContain('focus-42');
});
