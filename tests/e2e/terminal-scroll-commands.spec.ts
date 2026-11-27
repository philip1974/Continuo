// 终端滚动命令与 mac 未绑定 ⌘ 组合不进 shell(src/__tests__/terminal-scroll-commands)。走真实 PTY、shell 与 vim。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { COMMAND_LIST, COMMAND_SEARCH } from './helpers/palette';

test.skip(process.platform !== 'darwin', '⌘ 组合与默认键按 mac');

const terminalText = (window: Page) =>
  window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');
const viewport = (window: Page) => window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalViewport());

async function newTerminal(window: Page): Promise<void> {
  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).not.toBe('');
}

async function run(window: Page, command: string) {
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

/** 跑 `seq 1 300`,等输出完、视口在底部且有回滚。返回 baseY。 */
async function fillScrollback(window: Page): Promise<number> {
  await run(window, 'seq 1 300');
  await expect.poll(async () => (await terminalText(window)).split('\n').includes('300'), { timeout: 10_000 }).toBe(true);
  let baseY = 0;
  await expect
    .poll(async () => {
      const v = await viewport(window);
      baseY = v?.baseY ?? 0;
      return v && v.baseY > 0 && v.viewportY === v.baseY;
    }, { timeout: 10_000 })
    .toBe(true);
  return baseY;
}

const viewportY = async (window: Page) => (await viewport(window))?.viewportY;

/** 命令行没有被插入任何字节:键入的命令原样执行(`;9H` / `~` 等乱码会让命令变成别的)。 */
async function expectCleanCommandLine(window: Page, marker: string) {
  await run(window, `echo ${marker}-$((40+2))`);
  await expect.poll(async () => (await terminalText(window)).split('\n').includes(`${marker}-42`), { timeout: 10_000 }).toBe(true);
  expect(await terminalText(window)).not.toMatch(/;9[HF~]|\[1;9/);
}

test('⌘Home / ⌘End / ⌘PageUp / ⌘PageDown / ⌥⌘PageUp / ⌥⌘PageDown 滚动视口,命令行无乱码', async ({ window }) => {
  await newTerminal(window);
  const baseY = await fillScrollback(window);

  await window.keyboard.press('Meta+Home');
  await expect.poll(() => viewportY(window)).toBe(0);
  await window.keyboard.press('Meta+PageDown');
  await expect.poll(() => viewportY(window)).toBeGreaterThan(0);
  const page = (await viewportY(window))!;
  expect(page).toBeLessThan(baseY);
  await window.keyboard.press('Meta+PageUp');
  await expect.poll(() => viewportY(window)).toBe(0);
  await window.keyboard.press('Meta+Alt+PageDown');
  await expect.poll(() => viewportY(window)).toBe(1);
  await window.keyboard.press('Meta+Alt+PageUp');
  await expect.poll(() => viewportY(window)).toBe(0);
  // 无修饰 PageDown(VSCode mac 默认键)同样翻页
  await window.keyboard.press('PageDown');
  await expect.poll(() => viewportY(window)).toBe(page);
  await window.keyboard.press('Meta+End');
  await expect.poll(() => viewportY(window)).toBe(baseY);

  // 未绑定的 ⌘ + 功能键也不往 shell 写字节
  await window.keyboard.press('Meta+Delete');
  await window.keyboard.press('Meta+F5');
  await expectCleanCommandLine(window, 'clean');
});

test('命令面板里可见并作用于活动终端', async ({ window }) => {
  await newTerminal(window);
  await fillScrollback(window);
  await window.keyboard.press('Meta+Shift+P');
  const input = window.getByRole('combobox', { name: COMMAND_SEARCH });
  await expect(input).toBeVisible();
  await input.fill('Scroll to Top');
  const option = window
    .getByRole('listbox', { name: COMMAND_LIST })
    .getByRole('option')
    .filter({ hasText: /(Scroll to Top|滚动到顶部|맨 위로 스크롤)/ });
  await expect(option.first()).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => viewportY(window)).toBe(0);
});

test('改键生效:scrollToTop 改到 ⌃⌥U → ⌃⌥U 滚到顶;原 ⌘Home 不再滚动、也不进 shell', async ({ window }) => {
  await newTerminal(window);
  await window.evaluate(() => globalThis.__continuoTest!.setHotkey('workbench.action.terminal.scrollToTop', 'ctrl+alt+u'));
  const baseY = await fillScrollback(window);
  await window.keyboard.press('Meta+Home');
  await window.waitForTimeout(300);
  expect(await viewportY(window)).toBe(baseY);
  await window.keyboard.press('Control+Alt+KeyU');
  await expect.poll(() => viewportY(window)).toBe(0);
  await window.keyboard.press('Meta+End');
  await expect.poll(() => viewportY(window)).toBe(baseY);
  await expectCleanCommandLine(window, 'rebound');
});

test('vim(备用屏)里 ⌘Home / ⌘End / ⌘PageDown 不发给程序', async ({ window, workspaceRoot }) => {
  const file = path.join(workspaceRoot, 'vim-keys.txt');
  writeFileSync(file, 'XYZ\n');
  await newTerminal(window);
  // -u NONE:不读用户 vimrc;startinsert! = 在行尾进入插入模式
  await run(window, `vim -u NONE -N -n -c 'startinsert!' ${JSON.stringify(file)}`);
  await expect.poll(async () => (await viewport(window))?.alternate, { timeout: 10_000 }).toBe(true);
  await window.waitForTimeout(500);
  // ⌘Home 放最后:乱码进 vim 时它会被认成 Home / 打断插入,abc 不会接在行尾(⌘End 认成 End 时在行尾是空操作)
  await window.keyboard.press('Meta+End');
  await window.keyboard.press('Meta+PageDown');
  await window.keyboard.press('Meta+Home');
  await window.keyboard.type('abc');
  await window.keyboard.press('Escape');
  await run(window, ':wq');
  await expect.poll(async () => (await viewport(window))?.alternate, { timeout: 10_000 }).toBe(false);
  await expect.poll(() => readFileSync(file, 'utf-8'), { timeout: 10_000 }).toBe('XYZabc\n');
});
