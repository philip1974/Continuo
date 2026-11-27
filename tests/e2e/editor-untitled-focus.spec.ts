// ⌘N / 另存为后的焦点与无标题编辑器的可访问名称(BDD: src/__tests__/editor-save-as/「焦点」「无标题文件的显示名」)。
// 此前 ⌘N 只开 tab 不聚焦、另存为换 id 后视图重挂载 → 焦点停在 BODY,接着输入全部丢失。
// Playwright 默认焦点模拟会让 focus()/document.hasFocus() 失真 → 关掉它,用 document.activeElement 判焦点。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { DOCK_POPOUT, TERMINAL_INPUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { COMMAND_SEARCH } from './helpers/palette';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const UNTITLED_1 = /^(Untitled-1|无标题-1|제목 없음-1)/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function disableFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

async function launch(): Promise<{ app: ElectronApplication; win: Page; ws: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui127b-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui127b-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  await disableFocusEmulation(win);
  return { app, win, ws };
}

/** 焦点所在编辑区的可访问名称(不在 CodeMirror 文本区 → null)。 */
const focusedEditorLabel = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest('.cm-content')?.getAttribute('aria-label') ?? null);

/** 名称为 name 的编辑区(按可访问名称定位,不受别的组 / 隐藏视图干扰)。 */
const editorNamed = (page: Page, name: RegExp): Locator => page.locator('.cm-content').and(page.getByRole('textbox', { name }));

async function openA(win: Page): Promise<void> {
  await openTreeItem(win, /^a\.ts$/);
  await expect(win.locator('.cm-content').first()).toContainText('export const a', { timeout: 10_000 });
}

/** 保存对话框桩:返回 picked(null = 取消)。 */
async function stubSaveDialog(app: ElectronApplication, picked: string | null): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = (async () =>
      picked === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: picked }) as typeof dialog.showSaveDialog;
  }, picked);
}

test('编辑器里 ⌘N → 新的无标题编辑器获焦,接着输入落在新文件;读屏名称是「无标题-1」不是内部标识', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await openA(win);
  await win.locator('.cm-content').first().click();
  await win.keyboard.press('ControlOrMeta+n');
  await expect.poll(() => focusedEditorLabel(win), { timeout: 5_000 }).toMatch(UNTITLED_1);
  await win.keyboard.type('typed-into-untitled');
  const untitled = editorNamed(win, UNTITLED_1);
  await expect(untitled).toHaveText('typed-into-untitled');
  const label = await untitled.getAttribute('aria-label');
  expect(label).not.toContain('untitled:');
});

test('终端获焦时 ⌘N → 焦点进入新的无标题编辑器', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB }).last()).toBeVisible({ timeout: 15_000 });
  const term = win.getByRole('textbox', { name: TERMINAL_INPUT }).first();
  await expect(term).toBeAttached({ timeout: 15_000 });
  await term.focus();
  await expect.poll(() => win.evaluate(() => document.activeElement?.closest('.xterm') !== null)).toBe(true);
  await win.keyboard.press('ControlOrMeta+n');
  await expect.poll(() => focusedEditorLabel(win), { timeout: 5_000 }).toMatch(UNTITLED_1);
  await win.keyboard.type('from-terminal');
  await expect(editorNamed(win, UNTITLED_1)).toHaveText('from-terminal');
});

test('命令面板执行「新建无标题文本文件」→ 面板关闭后焦点留在新编辑器(不被还原回去)', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await openA(win);
  await win.locator('.cm-content').first().click();
  await win.keyboard.press('ControlOrMeta+Shift+p');
  await expect(win.getByRole('combobox', { name: COMMAND_SEARCH })).toBeVisible({ timeout: 10_000 });
  await win.keyboard.type('New Untitled Text File');
  await expect(win.getByRole('option').first()).toContainText(/(New Untitled Text File|新建无标题文本文件|제목 없는)/, {
    timeout: 10_000,
  });
  await win.keyboard.press('Enter');
  await expect.poll(() => focusedEditorLabel(win), { timeout: 5_000 }).toMatch(UNTITLED_1);
  await win.waitForTimeout(300);
  expect(await focusedEditorLabel(win)).toMatch(UNTITLED_1);
});

test('popout 子窗里 ⌘N → 子窗里的新编辑器获焦,输入落在新文件', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  await openA(win);
  await win.locator('.cm-content').first().click();
  const popoutBtn = win.getByRole('button', { name: DOCK_POPOUT });
  await expect(popoutBtn).toBeEnabled({ timeout: 10_000 });
  await popoutBtn.click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(2);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('.cm-content').first()).toContainText('export const a', { timeout: 10_000 });
  await disableFocusEmulation(child);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1'))?.focus();
  });
  await child.locator('.cm-content').first().click();
  await child.keyboard.press('ControlOrMeta+n');
  await expect.poll(() => focusedEditorLabel(child), { timeout: 5_000 }).toMatch(UNTITLED_1);
  await child.keyboard.type('in-child');
  await expect(editorNamed(child, UNTITLED_1)).toHaveText('in-child');
});

test('⇧⌘S 另存为成功 → 焦点在新路径的编辑器,光标仍在原处,接着输入落在编辑器', async () => {
  test.setTimeout(90_000);
  const { app, win, ws } = await launch();
  const copy = path.join(ws, 'copy.ts');
  await stubSaveDialog(app, copy);
  await openA(win);
  await win.locator('.cm-content').first().click();
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.type('// x');
  await win.keyboard.press('ControlOrMeta+Shift+S');
  await expect.poll(() => focusedEditorLabel(win), { timeout: 10_000 }).toMatch(/^copy\.ts/);
  await win.keyboard.type('y');
  await expect(editorNamed(win, /^copy\.ts/)).toContainText('// xy');
  expect(await readFile(copy, 'utf8')).toBe('export const a = 1;\n// x');
});

test('无标题文件 ⌘S(走另存为)成功 → 焦点在保存后的编辑器;取消 → 焦点留在无标题编辑器', async () => {
  test.setTimeout(90_000);
  const { app, win, ws } = await launch();
  await stubSaveDialog(app, null);
  await openA(win);
  await win.locator('.cm-content').first().click();
  await win.keyboard.press('ControlOrMeta+n');
  await expect.poll(() => focusedEditorLabel(win), { timeout: 5_000 }).toMatch(UNTITLED_1);
  await win.keyboard.type('note');
  await win.keyboard.press('ControlOrMeta+s');
  await win.waitForTimeout(300);
  expect(await focusedEditorLabel(win)).toMatch(UNTITLED_1);

  const target = path.join(ws, 'note.txt');
  await stubSaveDialog(app, target);
  await win.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => focusedEditorLabel(win), { timeout: 10_000 }).toMatch(/^note\.txt/);
  await win.keyboard.type('!');
  await expect(editorNamed(win, /^note\.txt/)).toHaveText('note!');
});
