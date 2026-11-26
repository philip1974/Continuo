// popout 子窗里打开选择器 / 主窗面板(BDD: src/__tests__/popout-picker/)。编辑器组弹出到子窗、子窗获焦后经菜单钩子
//(与真实点击同一路径)或按键触发:
// 1. 转到文件 / 命令面板 / 转到行 / 打开最近 → 选择器画在子窗、子窗仍是获焦窗口、输入进选择器、Esc 在子窗关闭、选中后作用于
//    子窗的编辑器组(此前画在主窗,焦点留在子窗,接着输入的字进了子窗编辑器,子窗里 Esc 关不掉)
// 2. ⇧⌘F(在文件中查找)→ 搜索面板在主窗打开并激活主窗,输入进搜索框(VSCode 同)
// Playwright 默认焦点模拟让每个窗口 document.hasFocus() 都为 true → 关掉它,用 BrowserWindow.focus() 真正切换窗口。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mac = process.platform === 'darwin';
// macOS 顶层:应用 0 / 文件 1 / 编辑 2 / 选择 3 / 显示 4 / 转到 5;其它平台没有应用菜单
const FILE = mac ? 1 : 0;
const EDIT = mac ? 2 : 1;
const VIEW = mac ? 4 : 3;
const GOTO = mac ? 5 : 4;

const editorRoots = (page: Page) => page.locator('[data-editor-panel-root]');
const dialog = (page: Page) => page.locator('[role="dialog"]');
const dialogInput = (page: Page) => dialog(page).locator('input').first();

const snapshot = (app: ElectronApplication): Promise<MenuSnapshotItem[]> =>
  app.evaluate(() => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot());

function pathOf(items: readonly MenuSnapshotItem[], top: number, id: string): number[] {
  const walk = (list: readonly MenuSnapshotItem[], prefix: number[]): number[] | null => {
    for (const [i, m] of list.entries()) {
      if (m.id === id) return [...prefix, i];
      const sub = m.submenu ? walk(m.submenu, [...prefix, i]) : null;
      if (sub) return sub;
    }
    return null;
  };
  const found = walk(items[top]!.submenu ?? [], [top]);
  if (!found) throw new Error(`menu item ${id} not found in top menu ${top}`);
  return found;
}

const windowId = (app: ElectronApplication, popout: boolean): Promise<number> =>
  app.evaluate(
    ({ BrowserWindow }, popout) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1') === popout)!.id,
    popout,
  );

/** 子窗获焦时点菜单项(viaKey = 由 accelerator 触发)。 */
async function clickMenuInPopout(app: ElectronApplication, top: number, id: string, viaKey = false): Promise<void> {
  const p = pathOf(await snapshot(app), top, id);
  const winId = await windowId(app, true);
  const ok = await app.evaluate(
    (_e, { p, winId, viaKey }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId, viaKey),
    { p, winId, viaKey },
  );
  expect(ok).toBe(true);
}

/** 当前获焦的是哪个窗口(main 进程视角)。 */
const focusedWindow = (app: ElectronApplication): Promise<'main' | 'popout' | null> =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getFocusedWindow();
    return w ? (w.webContents.getURL().includes('popout=1') ? 'popout' : 'main') : null;
  });

const focusPopout = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1'))?.focus();
  });

async function disableFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

/** 主窗编辑器组开 main-file.ts;⌘\ 拆出第二组开 child-file.ts 并弹出到子窗;关焦点模拟,切到子窗。 */
async function setup(): Promise<{ app: ElectronApplication; win: Page; child: Page; recent: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui102c-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui102c-ws-'));
  const recent = mkdtempSync(path.join(tmpdir(), 'ui102c-recent-'));
  dirs.push(ud, ws, recent);
  writeFileSync(path.join(ws, 'main-file.ts'), 'export const main = 1;\n');
  writeFileSync(path.join(ws, 'child-file.ts'), 'export const child = 2;\nexport const line2 = 22;\nexport const line3 = 33;\n');
  writeFileSync(path.join(ws, 'zebra-target.ts'), 'export const zebra = 9;\n');
  seedExplorerJson(ud, { root: ws, recentRoots: [ws, recent] });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  await openTreeItem(win, /^main-file\.ts$/);
  const cm = editorRoots(win).first().locator('.cm-content');
  await expect(cm).toContainText('export const main', { timeout: 10_000 });
  await cm.click();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(editorRoots(win)).toHaveCount(2, { timeout: 10_000 });
  await openTreeItem(win, /^child-file\.ts$/);
  await expect(editorRoots(win).nth(1).locator('.cm-content')).toContainText('export const child', { timeout: 10_000 });
  await editorRoots(win).nth(1).locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(editorRoots(child).locator('.cm-content')).toContainText('export const child', { timeout: 10_000 });

  await disableFocusEmulation(win);
  await disableFocusEmulation(child);
  await focusPopout(app);
  await expect.poll(() => focusedWindow(app)).toBe('popout');
  await editorRoots(child).locator('.cm-content').click();
  return { app, win, child, recent };
}

/** 选择器在子窗、焦点在其输入框、子窗仍是获焦窗口;主窗没有选择器。 */
async function expectPickerInPopout(app: ElectronApplication, win: Page, child: Page): Promise<void> {
  await expect(dialog(child)).toBeVisible({ timeout: 10_000 });
  await expect(dialog(win)).toHaveCount(0);
  await expect.poll(() => child.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null)).toBe(true);
  expect(await focusedWindow(app)).toBe('popout');
}

test('子窗获焦时经菜单打开 转到文件 / 命令面板 / 转到行 / 打开最近:画在子窗,输入进选择器,Esc 在子窗关闭,选中作用于子窗', async () => {
  test.setTimeout(150_000);
  const { app, win, child, recent } = await setup();
  const childCm = editorRoots(child).locator('.cm-content');
  const mainCm = editorRoots(win).first().locator('.cm-content');

  // 转到文件:输入 → 选择器;Enter → 文件开在子窗的编辑器组,主窗编辑器不变
  await clickMenuInPopout(app, GOTO, 'workbench.action.quickOpen');
  await expectPickerInPopout(app, win, child);
  await child.keyboard.type('zebra');
  await expect(dialogInput(child)).toHaveValue('zebra');
  await expect(dialog(child).getByText('zebra-target.ts').first()).toBeVisible({ timeout: 10_000 });
  await child.keyboard.press('Enter');
  await expect(dialog(child)).toHaveCount(0);
  await expect(editorRoots(child).locator('.cm-content')).toContainText('export const zebra', { timeout: 10_000 });
  await expect(mainCm).toContainText('export const main');
  await expect(mainCm).not.toContainText('zebra');

  // 回到 child-file.ts
  await child.getByRole('tab', { name: /child-file\.ts/ }).click();
  await expect(childCm).toContainText('export const child');

  // 命令面板:输入 xyz 进面板,不进子窗编辑器;Esc 在子窗关闭,焦点回子窗编辑器
  await clickMenuInPopout(app, VIEW, 'workbench.action.showCommands');
  await expectPickerInPopout(app, win, child);
  await child.keyboard.type('xyz');
  await expect(dialogInput(child)).toHaveValue('xyz');
  await child.keyboard.press('Escape');
  await expect(dialog(child)).toHaveCount(0);
  await expect(childCm).not.toContainText('xyz');
  await expect.poll(() => child.evaluate(() => document.activeElement?.closest('.cm-editor') != null)).toBe(true);

  // 转到行(经 accelerator 触发,viaKey):预填 `:`;输入 3 + Enter → 子窗编辑器光标到第 3 行
  await clickMenuInPopout(app, GOTO, 'workbench.action.gotoLine', true);
  await expectPickerInPopout(app, win, child);
  await expect(dialogInput(child)).toHaveValue(':');
  await child.keyboard.type('3');
  await child.keyboard.press('Enter');
  await expect(dialog(child)).toHaveCount(0);
  await expect(child.locator('.cm-activeLine')).toContainText('line3');
  await expect.poll(() => child.evaluate(() => document.activeElement?.closest('.cm-editor') != null)).toBe(true);
  expect(await focusedWindow(app)).toBe('popout');

  // 打开最近:列出最近文件夹;Esc 在子窗关闭
  await clickMenuInPopout(app, FILE, 'workbench.action.openRecent');
  await expectPickerInPopout(app, win, child);
  await expect(dialog(child).getByText(path.basename(recent)).first()).toBeVisible({ timeout: 10_000 });
  await child.keyboard.press('Escape');
  await expect(dialog(child)).toHaveCount(0);
  await expect(dialog(win)).toHaveCount(0);
});

test('子窗里按 ⌘P / ⇧⌘P / ⌃G:选择器画在子窗;同一窗口再按 ⌘P 关闭', async () => {
  test.setTimeout(120_000);
  const { app, win, child } = await setup();

  await child.keyboard.press('ControlOrMeta+p');
  await expectPickerInPopout(app, win, child);
  await child.keyboard.press('ControlOrMeta+p');
  await expect(dialog(child)).toHaveCount(0);

  await child.keyboard.press('ControlOrMeta+Shift+p');
  await expectPickerInPopout(app, win, child);
  await child.keyboard.press('Escape');
  await expect(dialog(child)).toHaveCount(0);

  await editorRoots(child).locator('.cm-content').click();
  await child.keyboard.press('Control+g');
  await expectPickerInPopout(app, win, child);
  await expect(dialogInput(child)).toHaveValue(':');
  await child.keyboard.press('Escape');
  await expect(dialog(child)).toHaveCount(0);
});

test('子窗获焦时 ⇧⌘F(菜单 编辑 → 在文件中查找):搜索面板在主窗打开并激活主窗,输入进搜索框', async () => {
  test.setTimeout(120_000);
  const { app, win, child } = await setup();
  const childCm = editorRoots(child).locator('.cm-content');

  await clickMenuInPopout(app, EDIT, 'workbench.action.findInFiles', true);
  await expect.poll(() => focusedWindow(app), { timeout: 10_000 }).toBe('main');
  await expect
    .poll(() => win.evaluate(() => document.hasFocus() && document.activeElement instanceof HTMLInputElement))
    .toBe(true);
  expect(await child.evaluate(() => document.hasFocus())).toBe(false);
  await win.keyboard.type('needle');
  await expect.poll(() => win.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe('needle');
  await expect(childCm).not.toContainText('needle');
});
