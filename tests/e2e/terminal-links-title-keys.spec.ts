// 终端:文件链接 ⌘ + 单击打开并定位(src/__tests__/terminal-file-links)、mac 行内编辑键(terminal-vscode-parity 10)、
// 进程名标题 / 重命名(src/__tests__/terminal-title)。走真实 PTY 与 shell。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import { TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const terminalText = (window: Page) =>
  window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');

async function newTerminal(window: Page): Promise<Locator> {
  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  const byName = window.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  await expect(byName).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  const input = window.getByRole('textbox', { name: TERMINAL_INPUT });
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.focus();
  await expect.poll(() => terminalText(window), { timeout: 15_000 }).not.toBe('');
  // 标题会随前台程序变,之后按面板 id 找 tab。
  return window.locator(`[role=tab][data-panel-id="${await byName.getAttribute('data-panel-id')}"]`);
}

async function run(window: Page, command: string) {
  await window.keyboard.type(command);
  await window.keyboard.press('Enter');
}

/** 缓冲区里内容恰为 text 的最后一行的行号(用例输出少,无回滚:行号 = 视口行)。 */
async function rowOf(window: Page, text: string): Promise<number> {
  let row = -1;
  await expect
    .poll(async () => {
      row = (await terminalText(window)).split('\n').lastIndexOf(text);
      return row;
    }, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(0);
  return row;
}

/** 视口单元格 (col, row)(0 起)中心的页面坐标:`stty size` 取行列数,按 xterm 屏幕元素尺寸均分。 */
async function cellCenter(window: Page, col: number, row: number) {
  await run(window, 'stty size');
  let size: [number, number] = [0, 0];
  await expect
    .poll(async () => {
      const m = [...(await terminalText(window)).matchAll(/^(\d+) (\d+)$/gm)].pop();
      size = m ? [Number(m[1]), Number(m[2])] : [0, 0];
      return size[0];
    }, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const box = (await window.locator('[data-testid=terminal-panel-view-xterm-host] .xterm-screen').boundingBox())!;
  const [rows, cols] = size;
  return { x: box.x + (col + 0.5) * (box.width / cols), y: box.y + (row + 0.5) * (box.height / rows) };
}

test('文件链接:悬停显示提示,修饰键 + 单击在编辑器打开并定位行列', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'src', 'multi.ts'), 'line1\n    hello world\nline3\n');
  await newTerminal(window);
  await run(window, 'echo src/multi.ts:2:5 && echo nope/missing.ts:1');
  const row = await rowOf(window, 'src/multi.ts:2:5');
  const missingRow = await rowOf(window, 'nope/missing.ts:1');
  const host = window.locator('[data-testid=terminal-panel-view-xterm-host]');

  // 不存在的文件不是链接(不出提示)
  const miss = await cellCenter(window, 3, missingRow);
  await window.mouse.move(miss.x, miss.y);
  await window.waitForTimeout(500);
  await expect(host).not.toHaveAttribute('title', /.+/);

  const at = await cellCenter(window, 3, row);
  await window.mouse.move(at.x, at.y + 1);
  await window.mouse.move(at.x, at.y);
  await expect(host).toHaveAttribute('title', /(click to open file|单击打开文件|클릭하여 파일 열기)/, { timeout: 5_000 });

  // 不带修饰键单击不打开
  await window.mouse.click(at.x, at.y);
  await window.waitForTimeout(300);
  expect(await window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId())).toBeNull();

  await window.keyboard.down(MOD);
  await window.mouse.click(at.x, at.y);
  await window.keyboard.up(MOD);
  await expect
    .poll(() => window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId()), { timeout: 10_000 })
    .toMatch(/multi\.ts$/);
  // 光标落在第 2 行第 5 列(0 起偏移 4)
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const sel = document.getSelection();
          const line = sel?.anchorNode?.parentElement?.closest('.cm-line') ?? (sel?.anchorNode as Element | null)?.closest?.('.cm-line');
          if (!sel?.anchorNode || !line) return null;
          const r = document.createRange();
          r.setStart(line, 0);
          r.setEnd(sel.anchorNode, sel.anchorOffset);
          return `${line.textContent}|${r.toString().length}`;
        }),
      { timeout: 10_000 },
    )
    .toBe('    hello world|4');
});

test('文件链接:(line,col) 形态,相对路径按终端 cwd(工作区根)解析', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'file-2.ts'), 'first line\n');
  await newTerminal(window);
  await run(window, 'echo "./file-2.ts(1,3)"');
  const row = await rowOf(window, './file-2.ts(1,3)');
  const at = await cellCenter(window, 2, row);
  await window.mouse.move(at.x, at.y + 1);
  await window.mouse.move(at.x, at.y);
  await expect(window.locator('[data-testid=terminal-panel-view-xterm-host]')).toHaveAttribute(
    'title',
    /(click to open file|单击打开文件|클릭하여 파일 열기)/,
    { timeout: 5_000 },
  );
  await window.keyboard.down(MOD);
  await window.mouse.click(at.x, at.y);
  await window.keyboard.up(MOD);
  await expect
    .poll(() => window.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId()), { timeout: 10_000 })
    .toMatch(/file-2\.ts$/);
});

test('mac:⌘← / ⌘→ / ⌘⌫ / ⌥← 行内编辑', async ({ window }) => {
  test.skip(process.platform !== 'darwin', '仅 mac 默认绑定');
  await newTerminal(window);
  await window.keyboard.type('echo abc def');
  await window.keyboard.press('Meta+ArrowLeft');
  await window.keyboard.type(': ; ');
  await window.keyboard.press('Meta+ArrowRight');
  await window.keyboard.type(' xyz');
  await window.keyboard.press('Alt+ArrowLeft');
  await window.keyboard.type('W');
  await window.keyboard.press('Enter');
  await rowOf(window, 'abc def Wxyz');

  await window.keyboard.type('echo should-not-run');
  await window.keyboard.press('Meta+Backspace');
  await run(window, 'echo after-kill');
  await rowOf(window, 'after-kill');
  expect(await terminalText(window)).not.toMatch(/^should-not-run$/m);
});

test('标题显示前台进程名(空闲时为 shell 名)而非 OSC 标题;重命名固定', async ({ window }) => {
  const tab = await newTerminal(window);
  // 空闲:shell 名(VSCode `${process}`),不是默认名「终端 N」
  await expect(tab).toHaveAccessibleName(TERMINAL_PANEL_TAB);
  await expect(tab).not.toHaveAccessibleName(/^(Terminal|终端|터미널) \d/);
  const shellName = (await tab.getAttribute('aria-labelledby').then((id) => window.locator(`[id="${id}"]`).textContent()))!;

  // 程序经 OSC 0 设的标题不显示
  await run(window, "printf '\\033]0;MYTITLE\\007'");
  await window.waitForTimeout(800);
  await expect(tab).toHaveAccessibleName(shellName);

  // 运行程序时显示程序名,结束后回到 shell 名
  await run(window, 'sleep 2');
  await expect(tab).toHaveAccessibleName(/^sleep/, { timeout: 5_000 });
  await expect(tab).toHaveAccessibleName(shellName, { timeout: 10_000 });

  // 右键「重命名…」→ 输入 → 回车:固定标题,之后进程名变化不再覆盖
  await tab.click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^(Rename…|重命名…|이름 바꾸기…)$/ }).click();
  const dialog = window.getByRole('dialog');
  const input = dialog.getByRole('textbox');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(shellName);
  await input.fill('my-build');
  await input.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(tab).toHaveAccessibleName(/^my-build/);
  // 关闭后焦点回终端:直接键入命令
  await run(window, 'sleep 1');
  await window.waitForTimeout(500);
  await expect(tab).toHaveAccessibleName(/^my-build/);

  // 重命名为空 → 回到自动标题(进程名)
  await tab.click({ button: 'right' });
  await window.getByRole('menuitem', { name: /^(Rename…|重命名…|이름 바꾸기…)$/ }).click();
  await window.getByRole('dialog').getByRole('textbox').fill('');
  await window.getByRole('dialog').getByRole('textbox').press('Enter');
  await expect(tab).toHaveAccessibleName(shellName, { timeout: 5_000 });
});
