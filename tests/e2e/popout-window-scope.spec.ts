// popout 子窗与主窗各管各的(VSCode:命令作用于触发它的窗口)。BDD: src/__tests__/workbench-editor-commands/ 第 7 条、
// src/__tests__/popout-open-target/。
// 1. 子窗里按 ⌘W 只关子窗的面板;子窗没有可关的面板只关子窗 —— 此前关掉主窗的文件 tab、编辑器面板,最后关掉整个主窗。
// 2. 整组弹出后主窗只剩隐藏的引用组:关光主窗面板再「显示输出」→ 仍在主窗可见 —— 此前落进 0 宽的隐藏组,主窗 dock 空白。
// 3. 编辑器组弹出后在两窗间切换:主窗标题 / 状态栏只显示主窗的文件、子窗原生标题是子窗的文件;切回主窗后 ⌘\ /「关闭组中的
//    所有编辑器」作用于主窗(第 8 条、src/__tests__/chrome-active-panel/)。带着弹出的编辑器组重启:活动组仍是主窗组、
//    两窗原生标题各是自己的文件、焦点在主窗编辑器。
//    Playwright 默认焦点模拟让每个窗口 document.hasFocus() 都为 true、子窗 focus 事件不触发 → 关掉它,用 BrowserWindow.focus()
//    真正切换窗口。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ── 3. 编辑器组弹出后的窗口作用域 ──

const editorRoots = (page: Page) => page.locator('[data-editor-panel-root]');

/** 关掉 Playwright 的焦点模拟(否则每个窗口都「有焦点」,窗口 focus 事件也不触发)。 */
async function disableFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

/** 真正切换到主窗 / popout 子窗(BrowserWindow.focus,同 ⌘` / 点标题栏)。 */
const focusWindow = (app: ElectronApplication, popout: boolean): Promise<void> =>
  app.evaluate(({ BrowserWindow }, popout) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1') === popout)?.focus();
  }, popout);

/** 主窗 / 子窗的原生窗口标题(Dock / 窗口菜单 / ⌘` 显示)。 */
const nativeTitle = (app: ElectronApplication, popout: boolean): Promise<string> =>
  app.evaluate(
    ({ BrowserWindow }, popout) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1') === popout)?.getTitle() ?? '',
    popout,
  );

function editorWorkspace(): string {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui93a-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui93a-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'main-file.ts'), 'export const main = 1;\n');
  writeFileSync(path.join(ws, 'child-file.ts'), 'export const child = 2;\n');
  mkdirSync(path.join(ws, 'src'));
  writeFileSync(path.join(ws, 'src', 'inner.ts'), 'export const inner = 3;\n');
  seedExplorerJson(ud, { root: ws });
  return ud;
}

async function launchIn(ud: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

async function waitForChild(app: ElectronApplication, win: Page): Promise<Page> {
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });
  return child;
}

/** 主窗编辑器组开 main-file.ts;⌘\ 拆出第二组并在其中开 child-file.ts;把第二组弹出到子窗。 */
async function popOutSecondEditorGroup(app: ElectronApplication, win: Page): Promise<Page> {
  await openTreeItem(win, /^main-file\.ts$/);
  const cm = editorRoots(win).first().locator('.cm-content');
  await expect(cm).toContainText('export const main', { timeout: 10_000 });
  await cm.click();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(editorRoots(win)).toHaveCount(2, { timeout: 10_000 });
  await openTreeItem(win, /^child-file\.ts$/);
  await expect(editorRoots(win).nth(1).locator('.cm-content')).toContainText('export const child', { timeout: 10_000 });
  await editorRoots(win)
    .nth(1)
    .locator('xpath=ancestor::*[contains(@class,"dv-groupview")]')
    .getByRole('button', { name: DOCK_POPOUT })
    .click();
  const child = await waitForChild(app, win);
  await expect(editorRoots(child).locator('.cm-content')).toContainText('export const child', { timeout: 10_000 });
  await expect(editorRoots(win)).toHaveCount(1);
  return child;
}

test('编辑器组弹出后切换窗口:主窗标题 / 状态栏不变成子窗的文件;切回主窗后 ⌘\\ 与「关闭组中的所有编辑器」作用于主窗', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launchIn(editorWorkspace());
  const child = await popOutSecondEditorGroup(app, win);
  await disableFocusEmulation(win);
  await disableFocusEmulation(child);
  const header = win.locator('header').first();
  const footer = win.locator('footer').first();

  // 主窗点资源管理器的 src 文件夹(焦点不在面板内容里),切到子窗
  await focusWindow(app, false);
  await win.getByRole('treeitem', { name: /^src$/ }).click();
  await focusWindow(app, true);
  await expect.poll(() => child.evaluate(() => document.hasFocus())).toBe(true);
  await expect(header).toContainText('main-file.ts');
  await expect(header).not.toContainText('child-file.ts');
  await expect(footer).toContainText('main-file.ts');
  await expect(footer).not.toContainText('child-file.ts');
  await expect.poll(() => nativeTitle(app, false)).toContain('main-file.ts');
  await expect.poll(() => nativeTitle(app, true)).toContain('child-file.ts');

  // 切回主窗按 ⌘\ → 拆主窗的组,子窗不多出组
  await focusWindow(app, false);
  await expect.poll(() => win.evaluate(() => document.hasFocus())).toBe(true);
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(editorRoots(win)).toHaveCount(2, { timeout: 10_000 });
  await expect(editorRoots(child)).toHaveCount(1);

  // 再切到子窗、切回主窗(焦点放在资源管理器),「关闭组中的所有编辑器」→ 关主窗的,子窗的 tab 还在
  await focusWindow(app, true);
  await expect.poll(() => child.evaluate(() => document.hasFocus())).toBe(true);
  await focusWindow(app, false);
  await expect.poll(() => win.evaluate(() => document.hasFocus())).toBe(true);
  await win.getByRole('treeitem', { name: /^src$/ }).click();
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.closeEditorsInGroup'))).toBe(true);
  await expect(editorRoots(win)).toHaveCount(1, { timeout: 10_000 });
  await expect(editorRoots(child).getByRole('tablist', { name: EDITOR_TABS }).getByRole('tab', { name: /child-file\.ts/ })).toBeVisible();
});

test('带着弹出的编辑器组重启:活动组仍是主窗组,两窗原生标题各是自己的文件,焦点在主窗编辑器', async () => {
  test.setTimeout(150_000);
  const ud = editorWorkspace();
  let { app, win } = await launchIn(ud);
  let child = await popOutSecondEditorGroup(app, win);
  await disableFocusEmulation(win);
  await disableFocusEmulation(child);
  // 最后用的是主窗编辑器
  await focusWindow(app, false);
  await editorRoots(win).first().locator('.cm-content').click();
  const persisted = () => {
    try {
      const json = JSON.parse(readFileSync(path.join(ud, 'explorer.json'), 'utf8')) as {
        windows?: Array<{ windowSeq: number; layout?: { activeGroup?: string; popoutGroups?: unknown[] }; editor?: { activeGroup?: string } }>;
      };
      const w = json.windows?.find((x) => x.windowSeq === 0);
      return { popouts: w?.layout?.popoutGroups?.length ?? 0, editorGroup: w?.editor?.activeGroup ?? null, dockGroup: w?.layout?.activeGroup ?? null };
    } catch {
      return null;
    }
  };
  await expect.poll(() => persisted()?.popouts, { timeout: 15_000 }).toBe(1);
  await expect.poll(() => persisted()?.editorGroup, { timeout: 15_000 }).toBe('editor');
  const dockGroupBefore = persisted()!.dockGroup;
  expect(dockGroupBefore).not.toBeNull();

  await app.close();
  apps.splice(apps.indexOf(app), 1);
  ({ app, win } = await launchIn(ud));
  child = await waitForChild(app, win);
  await expect(editorRoots(child).locator('.cm-content')).toContainText('export const child', { timeout: 15_000 });

  const header = win.locator('header').first();
  await expect(header).toContainText('main-file.ts', { timeout: 10_000 });
  await expect(header).not.toContainText('child-file.ts');
  await expect(win.locator('footer').first()).toContainText('main-file.ts');
  await expect.poll(() => nativeTitle(app, false), { timeout: 10_000 }).toContain('main-file.ts');
  await expect.poll(() => nativeTitle(app, true), { timeout: 10_000 }).toContain('child-file.ts');
  // 焦点在主窗编辑器(可直接键入)
  await expect
    .poll(() => win.evaluate(() => document.activeElement?.closest('[data-editor-panel-root]') !== null), { timeout: 10_000 })
    .toBe(true);
  // 落定后持久化的活动组仍是主窗的
  await expect.poll(() => persisted()?.editorGroup, { timeout: 10_000 }).toBe('editor');
  await expect.poll(() => persisted()?.dockGroup, { timeout: 10_000 }).toBe(dockGroupBefore);
});
