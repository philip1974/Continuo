// 重新打开已关闭的编辑器(⇧⌘T / Ctrl+Shift+T,VSCode workbench.action.reopenClosedEditor):回到原位置、焦点与光标
// 回到关闭前;拆分后回原编辑器组;文件已删除则跳过取下一条。BDD: src/__tests__/editor-reopen-closed/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { EDITOR_TABS } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REOPEN = 'ControlOrMeta+Shift+T';
const groups = (win: Page): Locator => win.locator('[data-editor-panel-root]');
const group = (win: Page, i: number): Locator => groups(win).nth(i);
const tabTitles = (g: Locator): Promise<string[]> =>
  g
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop() ?? ''));
const focusedGroupIndex = (win: Page): Promise<number> =>
  win.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-editor-panel-root]')];
    const root = document.activeElement?.closest('[data-editor-panel-root]');
    return root ? roots.indexOf(root) : -1;
  });

let wsDir = '';

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui63u-ud-'));
  wsDir = mkdtempSync(path.join(tmpdir(), 'ui63u-ws-'));
  dirs.push(ud, wsDir);
  writeFileSync(path.join(wsDir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(wsDir, 'b.ts'), 'export const b = 2;\nexport const bb = 3;\n');
  writeFileSync(path.join(wsDir, 'c.ts'), 'export const c = 4;\n');
  seedExplorerJson(ud, { root: wsDir });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return win;
}

async function openFile(win: Page, name: RegExp, text: string, g = 0): Promise<void> {
  await openTreeItem(win, name);
  await expect(group(win, g).locator('.cm-content')).toContainText(text, { timeout: 10_000 });
}

test('⌘W 关掉中间的 tab → ⇧⌘T 回到原位置,焦点进入编辑器,光标在关闭前的位置', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openFile(win, /^a\.ts$/, 'export const a');
  await openFile(win, /^b\.ts$/, 'export const b');
  await openFile(win, /^c\.ts$/, 'export const c');
  await group(win, 0).getByRole('tab', { name: /b\.ts/ }).click();
  const cm = group(win, 0).locator('.cm-content');
  await expect(cm).toContainText('export const b');
  await cm.click();
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.press('ControlOrMeta+w');
  await expect.poll(() => tabTitles(group(win, 0))).toEqual(['a.ts', 'c.ts']);

  await win.keyboard.press(REOPEN);
  await expect.poll(() => tabTitles(group(win, 0))).toEqual(['a.ts', 'b.ts', 'c.ts']);
  await expect(cm).toContainText('export const b');
  await expect(cm).toBeFocused();
  // 光标仍在文末:输入落在最后一行,而不是文档开头
  await win.keyboard.type('Z');
  await expect(cm.locator('.cm-line').first()).toHaveText('export const b = 2;');
  await expect(cm.locator('.cm-line').last()).toHaveText('Z');
});

test('拆分后关掉右组的文件 → 焦点在左组时 ⇧⌘T 回到右组', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openFile(win, /^a\.ts$/, 'export const a');
  await group(win, 0).locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  await openFile(win, /^b\.ts$/, 'export const b', 1);
  await expect.poll(() => tabTitles(group(win, 1))).toEqual(['a.ts', 'b.ts']);
  await group(win, 1).locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+w');
  await expect.poll(() => tabTitles(group(win, 1))).toEqual(['a.ts']);

  await win.keyboard.press('ControlOrMeta+1');
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.press(REOPEN);
  await expect.poll(() => tabTitles(group(win, 1))).toEqual(['a.ts', 'b.ts']);
  expect(await tabTitles(group(win, 0))).toEqual(['a.ts']);
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
  await expect(group(win, 1).locator('.cm-content')).toContainText('export const b');
});

test('文件已删除 → 跳过它,重新打开再早关闭的那个', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openFile(win, /^a\.ts$/, 'export const a');
  await openFile(win, /^b\.ts$/, 'export const b');
  await openFile(win, /^c\.ts$/, 'export const c');
  await group(win, 0).getByRole('tab', { name: /a\.ts/ }).click();
  await group(win, 0).locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+w'); // 关 a.ts
  await expect.poll(() => tabTitles(group(win, 0))).not.toContain('a.ts');
  await group(win, 0).getByRole('tab', { name: /b\.ts/ }).click();
  await group(win, 0).locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+w'); // 关 b.ts
  await expect.poll(() => tabTitles(group(win, 0))).toEqual(['c.ts']);
  rmSync(path.join(wsDir, 'b.ts'));

  await win.keyboard.press(REOPEN);
  await expect.poll(() => tabTitles(group(win, 0))).toEqual(['a.ts', 'c.ts']);
  await expect(group(win, 0).locator('.cm-content')).toContainText('export const a');
});
