// 从资源管理器树拖到编辑器 / 终端(对齐 VSCode;BDD: src/__tests__/explorer-drag-out/):
// 拖到编辑器组 → 在该组常驻打开(多选打开多个);拖到组的右边缘 → 拆出新组打开;拖到终端 → 插入转义后的路径,不回车。
// 真实鼠标拖动(Playwright dragTo 截获 HTML5 拖放并带上 dragstart 写入的数据)。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/with-workspace';
import { waitForTestHooks } from './helpers/app-ready';
import {
  EDITOR_MODE_EDIT,
  EDITOR_MODE_SOURCE,
  EDITOR_TABS,
  EDITOR_UNSAVED_CHANGES_SELECTOR,
  TERMINAL_INPUT,
  TERMINAL_PANEL_TAB,
  editorModeButton,
} from './helpers/editor';
import { expandTreeItem, openTreeItem } from './helpers/explorer';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const rowOf = (window: Page, p: string) => window.locator(`[role=treeitem][title="${p}"]`);
const groups = (window: Page) => window.locator('[data-editor-panel-root]');
const tabNames = (window: Page, i: number) =>
  groups(window)
    .nth(i)
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .evaluateAll((els) =>
      els.map((el) => `${(el.getAttribute('title') ?? '').split(/[\\/]/).pop()}${el.querySelector('[data-preview]') ? ' (preview)' : ''}`),
    );
const activeTabName = (window: Page, i: number) =>
  groups(window)
    .nth(i)
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab', { selected: true })
    .getAttribute('title')
    .then((t) => t?.split(/[\\/]/).pop());

test.beforeEach(async ({ window }) => {
  // 不让失焦窗口被当成有焦点(编辑器获焦断言要看真实焦点)
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
});

test('拖到编辑器组 → 常驻打开(多选打开多个,第一个激活);拖到右边缘 → 拆出新组;文件夹不打开', async ({
  window,
  workspaceRoot,
}) => {
  const readme = path.join(workspaceRoot, 'README.md');
  const a = path.join(workspaceRoot, 'src/a.ts');
  const b = path.join(workspaceRoot, 'src/b.ts');
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });
  await openTreeItem(window, 'README.md');
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md']);
  await expandTreeItem(window, 'src');
  await expect(rowOf(window, a)).toBeVisible();

  // 单个文件拖到内容区中央 → 在该组常驻打开并激活、获焦
  const content = groups(window).nth(0);
  await rowOf(window, a).dragTo(content);
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts']);
  await expect.poll(() => activeTabName(window, 0)).toBe('a.ts');
  await expect
    .poll(() => window.evaluate(() => !!document.activeElement?.closest('[data-editor-panel-root]')))
    .toBe(true);

  // 多选(⌘ 单击加选 README + b.ts)拖到组内 tab 栏 → 都在该组(已开的只切换),第一个(README)激活;tab 栏不当顶部边缘拆分
  await rowOf(window, readme).click();
  await rowOf(window, b).click({ modifiers: [MOD] });
  await rowOf(window, b).dragTo(groups(window).nth(0).getByRole('tablist', { name: EDITOR_TABS }));
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts', 'b.ts']);
  await expect.poll(() => activeTabName(window, 0)).toBe('README.md');
  await expect(groups(window)).toHaveCount(1);

  // 单击预览打开的文件再拖进来 → 转常驻
  writeFileSync(path.join(workspaceRoot, 'c.ts'), 'export const c = 3;\n');
  const c = path.join(workspaceRoot, 'c.ts');
  await expect(rowOf(window, c)).toBeVisible({ timeout: 10_000 });
  await rowOf(window, c).click();
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts', 'b.ts', 'c.ts (preview)']);
  await expect(
    groups(window).nth(0).getByRole('tab', { name: /^c\.ts(, preview|，预览|, 미리보기)$/ }),
  ).toHaveCount(1);
  await rowOf(window, c).dragTo(content);
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts', 'b.ts', 'c.ts']);

  // 文件夹拖进来 → 什么都不打开
  await rowOf(window, path.join(workspaceRoot, 'src')).dragTo(content);
  await window.waitForTimeout(300);
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts', 'b.ts', 'c.ts']);
  await expect(groups(window)).toHaveCount(1);

  // 拖到内容区右边缘 → 右侧拆出新组,在其中打开
  const box = (await content.boundingBox())!;
  await rowOf(window, a).dragTo(content, { targetPosition: { x: box.width - 8, y: box.height / 2 } });
  await expect(groups(window)).toHaveCount(2);
  await expect.poll(() => tabNames(window, 1)).toEqual(['a.ts']);
  const [left, right] = await Promise.all([groups(window).nth(0).boundingBox(), groups(window).nth(1).boundingBox()]);
  expect(right!.x).toBeGreaterThan(left!.x);
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts', 'b.ts', 'c.ts']);
});

test('拖到终端 → 插入转义后的绝对路径(多选空格分隔),不回车', async ({ window, workspaceRoot }) => {
  writeFileSync(path.join(workspaceRoot, 'my file.txt'), 'x\n');
  const spaced = path.join(workspaceRoot, 'my file.txt');
  const readme = path.join(workspaceRoot, 'README.md');
  await expect(rowOf(window, spaced)).toBeVisible({ timeout: 10_000 });

  await waitForTestHooks(window);
  expect(await window.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(window.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveAttribute('aria-selected', 'true', {
    timeout: 15_000,
  });
  await expect(window.getByRole('textbox', { name: TERMINAL_INPUT })).toBeVisible({ timeout: 15_000 });
  const terminalText = () => window.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');
  await expect.poll(terminalText, { timeout: 15_000 }).not.toBe('');

  // ⌘ 单击只加选不打开文件(单击会以预览打开,编辑器会盖住同组的终端)
  await rowOf(window, readme).click({ modifiers: [MOD] });
  await rowOf(window, spaced).click({ modifiers: [MOD] });
  await expect(window.locator('[role=treeitem][aria-selected=true]')).toHaveCount(2);
  const host = window.locator('[data-testid=terminal-panel-view-xterm-host]');
  await rowOf(window, spaced).dragTo(host);
  // 终端按屏幕宽度折行:去掉换行再比
  const flat = async () => (await terminalText()).replace(/\n/g, '');
  const expected = `${readme} '${spaced}'`;
  await expect.poll(flat, { timeout: 10_000 }).toContain(expected);
  // 没有回车:命令没执行(不会出现 shell 对 README 的报错 / 新提示符),输入仍在当前行
  await window.waitForTimeout(500);
  expect(await flat()).not.toMatch(/permission denied|command not found/i);
  await expect(window.getByRole('textbox', { name: TERMINAL_INPUT })).toBeFocused();
});

test('拖到编辑器内容区(md 源码 / 编辑视图、ts;中央与边缘)只打开,不改当前文档;⇧ 放下插入链接 / 路径', async ({
  window,
  workspaceRoot,
}) => {
  test.setTimeout(90_000);
  const readme = path.join(workspaceRoot, 'README.md');
  const a = path.join(workspaceRoot, 'src/a.ts');
  const b = path.join(workspaceRoot, 'src/b.ts');
  const readmeText = readFileSync(readme, 'utf8');
  const aText = readFileSync(a, 'utf8');
  const content = groups(window).nth(0);
  const editorText = () => content.locator('.cm-content, .ProseMirror').first().innerText();
  await expect(rowOf(window, readme)).toBeVisible({ timeout: 10_000 });
  await expandTreeItem(window, 'src');
  await expect(rowOf(window, a)).toBeVisible();

  // md 源码视图:拖到中央 → 打开 a.ts;README 不变
  await openTreeItem(window, 'README.md');
  await editorModeButton(window, EDITOR_MODE_SOURCE).click();
  await expect(content.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  await rowOf(window, a).dragTo(content.locator('.cm-content'));
  await expect.poll(() => activeTabName(window, 0)).toBe('a.ts');
  // ts:拖到中央 → 打开 b.ts;a.ts 不变
  await rowOf(window, b).dragTo(content.locator('.cm-content'));
  await expect.poll(() => activeTabName(window, 0)).toBe('b.ts');
  await openTreeItem(window, 'a.ts');
  await expect.poll(() => activeTabName(window, 0)).toBe('a.ts');
  expect((await editorText()).trim()).toBe(aText.trim());

  // md 编辑视图:拖到中央 → 打开;拖到右边缘 → 拆分打开;README 不变
  await openTreeItem(window, 'README.md');
  await editorModeButton(window, EDITOR_MODE_EDIT).click();
  const pm = content.locator('.ProseMirror');
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await rowOf(window, b).dragTo(pm);
  await expect.poll(() => activeTabName(window, 0)).toBe('b.ts');
  await openTreeItem(window, 'README.md');
  await expect(pm).toBeVisible({ timeout: 10_000 });
  const box = (await content.boundingBox())!;
  await rowOf(window, a).dragTo(content, { targetPosition: { x: box.width - 8, y: box.height / 2 } });
  await expect(groups(window)).toHaveCount(2);
  await expect.poll(() => tabNames(window, 1)).toEqual(['a.ts']);
  await expect(pm).toHaveText('Test Workspace');
  await window.waitForTimeout(1_500); // 自动保存的防抖过后,磁盘上也没变
  expect(readFileSync(readme, 'utf8')).toBe(readmeText);
  expect(readFileSync(a, 'utf8')).toBe(aText);
  await expect(window.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toHaveCount(0);

  // ⇧ 放下:md 编辑视图插入相对链接,不打开新 tab
  await window.keyboard.down('Shift');
  await rowOf(window, b).dragTo(pm);
  await window.keyboard.up('Shift');
  await expect(pm.locator('a', { hasText: 'b.ts' })).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => tabNames(window, 0)).toEqual(['README.md', 'a.ts', 'b.ts']);
  await expect.poll(() => activeTabName(window, 0)).toBe('README.md');
  await window.keyboard.press('ControlOrMeta+KeyS');
  await expect.poll(() => readFileSync(readme, 'utf8')).toContain('[b.ts](src/b.ts)');
});
