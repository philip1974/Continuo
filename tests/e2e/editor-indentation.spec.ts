// 编辑器按文档缩进:4 空格 Python 回车缩进 4 格、tab 缩进 Python 回车插 tab、Makefile 里 Tab 插 tab(产出文件用 python3 / make
// 实际跑通);状态栏缩进项显示与切换;转换缩进一次撤销撤回;关闭检测后用默认值;设置页可见。BDD: src/__tests__/editor-indentation/
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { openWorkspaceFile } from './helpers/editor';
import { waitForTestHooks } from './helpers/app-ready';
import { COMMAND_LIST, openCommandPalette, commandPaletteInput } from './helpers/palette';
import { EDITOR_TAB, SETTINGS_NAV } from './helpers/settings';

test.use({
  // eslint-disable-next-line no-empty-pattern -- Playwright 夹具要求对象解构参数
  workspaceRoot: async ({}, use) => {
    const root = mkdtempSync(path.join(tmpdir(), 'ui138a-indent-ws-'));
    writeFileSync(path.join(root, 'four.py'), 'def f():\n    if True:');
    writeFileSync(path.join(root, 'tabs.py'), 'def f():\n\tif True:');
    writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@echo one\n');
    writeFileSync(path.join(root, 'four.ts'), 'function f() {\n    return 1;\n}\n');
    writeFileSync(path.join(root, 'two.py'), 'def f():\n  return 1\n');
    await use(root);
    rmSync(root, { recursive: true, force: true });
  },
});

const indentItem = (window: Page) => window.locator('footer [data-statusbar-indentation]');
const pick = (window: Page, id: string) => window.locator(`.wm-modal-content [data-encoding-pick="${id}"]`);
const SPACES = (n: number) => new RegExp(`^(Spaces: ${n}|空格：${n}|공백: ${n})$`);
const TABS = (n: number) => new RegExp(`^(Tab Size: ${n}|制表符长度：${n}|탭 크기: ${n})$`);
const read = (root: string, name: string) => readFileSync(path.join(root, name), 'utf8');

async function endOfDocument(window: Page): Promise<void> {
  await window.locator('.cm-content').first().click();
  await window.keyboard.press('ControlOrMeta+End');
}

async function save(window: Page): Promise<void> {
  await window.keyboard.press('ControlOrMeta+s');
}

/** python3 编译产出文件(IndentationError / TabError → 抛错)。 */
function pythonCompiles(file: string): void {
  execFileSync('python3', ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', file]);
}

test('4 空格 Python:行尾冒号回车缩进 4 格,python3 编译通过;状态栏「空格: 4」', async ({ window, workspaceRoot }) => {
  await openWorkspaceFile(window, ['four.py']);
  await expect(indentItem(window)).toHaveText(SPACES(4));
  await endOfDocument(window);
  await window.keyboard.press('Enter');
  await window.keyboard.insertText('return 1');
  await save(window);
  await expect.poll(() => read(workspaceRoot, 'four.py'), { timeout: 5_000 }).toBe('def f():\n    if True:\n        return 1');
  pythonCompiles(path.join(workspaceRoot, 'four.py'));
});

test('tab 缩进 Python:回车插 tab 不混空格,python3 编译通过;状态栏「制表符长度: 4」', async ({ window, workspaceRoot }) => {
  await openWorkspaceFile(window, ['tabs.py']);
  await expect(indentItem(window)).toHaveText(TABS(4));
  await endOfDocument(window);
  await window.keyboard.press('Enter');
  await window.keyboard.insertText('return 1');
  await save(window);
  await expect.poll(() => read(workspaceRoot, 'tabs.py'), { timeout: 5_000 }).toBe('def f():\n\tif True:\n\t\treturn 1');
  pythonCompiles(path.join(workspaceRoot, 'tabs.py'));
});

test('Makefile 规则下 Tab 插 tab,make 跑通', async ({ window, workspaceRoot }) => {
  await openWorkspaceFile(window, ['Makefile']);
  await expect(indentItem(window)).toHaveText(TABS(4));
  await endOfDocument(window);
  await window.keyboard.press('Tab');
  await window.keyboard.insertText('@echo two');
  await save(window);
  await expect.poll(() => read(workspaceRoot, 'Makefile'), { timeout: 5_000 }).toBe('all:\n\t@echo one\n\t@echo two');
  const out = execFileSync('make', ['-s', '-C', workspaceRoot], { encoding: 'utf8' });
  expect(out).toBe('one\ntwo\n');
});

test('状态栏切换缩进、转换缩进(一次撤销撤回;命令面板同名命令)', async ({ window, workspaceRoot }) => {
  await openWorkspaceFile(window, ['four.ts']);
  await expect(indentItem(window)).toHaveText(SPACES(4));

  // 使用空格缩进 → 2:之后 Tab 缩进 2 格
  await indentItem(window).click();
  await pick(window, 'editor.action.indentUsingSpaces').click();
  await pick(window, '2').click();
  await expect(indentItem(window)).toHaveText(SPACES(2));

  // 使用制表符缩进 → 4
  await indentItem(window).click();
  await pick(window, 'editor.action.indentUsingTabs').click();
  await pick(window, '4').click();
  await expect(indentItem(window)).toHaveText(TABS(4));

  // 将缩进转换为空格(命令面板):整篇行首 tab → 4 空格;先转成 tab 再转回
  await indentItem(window).click();
  await pick(window, 'editor.action.indentationToTabs').click();
  await window.locator('.cm-content').first().click();
  await save(window);
  await expect.poll(() => read(workspaceRoot, 'four.ts'), { timeout: 5_000 }).toBe('function f() {\n\treturn 1;\n}\n');

  await openCommandPalette(window);
  await commandPaletteInput(window).fill('Convert Indentation to Spaces');
  const option = window.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').first();
  await expect(option).toContainText(/Convert Indentation to Spaces|将缩进转换为空格|들여쓰기를 공백으로 변환/);
  await window.keyboard.press('Enter');
  await expect(indentItem(window)).toHaveText(SPACES(4));
  await window.locator('.cm-content').first().click();
  await save(window);
  await expect.poll(() => read(workspaceRoot, 'four.ts'), { timeout: 5_000 }).toBe('function f() {\n    return 1;\n}\n');

  // 一次撤销撤回整次转换
  await window.keyboard.press('ControlOrMeta+z');
  await save(window);
  await expect.poll(() => read(workspaceRoot, 'four.ts'), { timeout: 5_000 }).toBe('function f() {\n\treturn 1;\n}\n');
});

test('关闭检测 → 已打开文档即时改用默认值(4 空格);设置页可见三项', async ({ window }) => {
  await openWorkspaceFile(window, ['two.py']);
  await expect(indentItem(window)).toHaveText(SPACES(2));
  await waitForTestHooks(window);
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.detectIndentation', false));
  await expect(indentItem(window)).toHaveText(SPACES(4));
  // 默认值改用 tab → 即时生效
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.insertSpaces', false));
  await expect(indentItem(window)).toHaveText(TABS(4));
  await window.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.insertSpaces', true));

  await window.evaluate(() => globalThis.__continuoTest!.openOrFocusPanel('settings', 'settings', 'Settings'));
  const settingsNav = window.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(settingsNav).toBeVisible({ timeout: 10_000 });
  await settingsNav.getByRole('button', { name: EDITOR_TAB }).dispatchEvent('click');
  const main = window.locator('main');
  await expect(main.getByRole('spinbutton', { name: /^(制表符大小|Tab size|탭 크기)$/ })).toHaveValue('4');
  await expect(main.getByRole('switch', { name: /^(插入空格|Insert spaces|공백 삽입)$/ })).toHaveAttribute('aria-checked', 'true');
  await expect(main.getByRole('switch', { name: /^(检测缩进|Detect indentation|들여쓰기 감지)$/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
});
