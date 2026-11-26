// popout 子窗与主窗各管各的(VSCode:命令作用于触发它的窗口)。BDD: src/__tests__/workbench-editor-commands/ 第 7 条、
// src/__tests__/popout-open-target/。
// 1. 子窗里按 ⌘W 只关子窗的面板;子窗没有可关的面板只关子窗 —— 此前关掉主窗的文件 tab、编辑器面板,最后关掉整个主窗。
// 2. 整组弹出后主窗只剩隐藏的引用组:关光主窗面板再「显示输出」→ 仍在主窗可见 —— 此前落进 0 宽的隐藏组,主窗 dock 空白。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_EMPTY_MESSAGE, DOCK_POPOUT, EDITOR_TABS } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const OUTPUT_TAB = /^(输出|Output|출력)/;
const ALL_IN_OTHER_WINDOWS = /(其他窗口|other windows|다른 창)/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui91a-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui91a-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'file-0.ts'), 'export const zero = 0;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

const showOutput = (win: Page): Promise<boolean> =>
  win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.view.output'));

const outputTab = (page: Page) => page.locator('.dv-tab').filter({ hasText: OUTPUT_TAB });

async function popOutGroupOf(win: Page, app: ElectronApplication, tab: ReturnType<typeof outputTab>): Promise<Page> {
  await tab.click();
  await tab.locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });
  return child;
}

test('子窗里按 ⌘W 只关子窗的面板,子窗空了只关子窗;主窗文件、编辑器面板与主窗都不动', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  await openTreeItem(win, /^file-0\.ts$/);
  const editor = win.locator('[data-editor-panel-root]').first();
  await expect(editor.locator('.cm-content')).toContainText('export const zero', { timeout: 10_000 });

  expect(await showOutput(win)).toBe(true);
  const child = await popOutGroupOf(win, app, outputTab(win));
  await expect(outputTab(child)).toBeVisible();
  await expect(outputTab(win)).toHaveCount(0);

  // 用户先点主窗编辑器(活动面板在主窗),再切到子窗按 ⌘W
  await win.bringToFront();
  await editor.locator('.cm-content').click();
  await child.bringToFront();
  await child.keyboard.press('ControlOrMeta+w');

  // 子窗的输出关掉(子窗随之关闭或变空),主窗文件 tab、编辑器面板、主窗都还在
  await expect.poll(() => (child.isClosed() ? 0 : outputTab(child).count())).toBe(0);
  if (!child.isClosed()) {
    await child.keyboard.press('ControlOrMeta+w');
    await expect.poll(() => child.isClosed()).toBe(true);
  }
  expect(win.isClosed()).toBe(false);
  await expect(editor.getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab', { name: /file-0\.ts/ })).toBeVisible();
  expect(app.windows()).toContain(win);
});

test('整组弹出后主窗关光再「显示输出」→ 输出在主窗可见(不落进 0 宽的隐藏组)', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  const popoutBtn = win.getByRole('button', { name: DOCK_POPOUT });
  await expect(popoutBtn).toBeEnabled({ timeout: 10_000 });
  await popoutBtn.click();
  await expect.poll(() => app.windows().length).toBeGreaterThan(1);
  const empty = win.locator('[data-dock-empty]');
  await expect(empty).toContainText(ALL_IN_OTHER_WINDOWS, { timeout: 10_000 });

  await win.bringToFront();
  expect(await showOutput(win)).toBe(true);
  await expect(outputTab(win)).toBeVisible();
  await expect(empty).toHaveCount(0);

  // 主窗按 ⌘W 关光输出 → 回到空态
  await outputTab(win).click();
  await win.keyboard.press('ControlOrMeta+w');
  await expect(outputTab(win)).toHaveCount(0);
  await expect(empty).toBeVisible();

  // 再「显示输出」:必须在主窗看得见,空态消失
  expect(await showOutput(win)).toBe(true);
  await expect(outputTab(win)).toBeVisible();
  await expect(win.locator('.dv-tab').filter({ hasText: OUTPUT_TAB }).locator('xpath=ancestor::*[contains(@class,"dv-groupview")]')).toBeVisible();
  await expect(empty).toHaveCount(0);
  await expect(win.getByText(DOCK_EMPTY_MESSAGE)).toHaveCount(0);
});
