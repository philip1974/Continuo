// 终端获焦时切换到下一个 / 上一个终端(⇧⌘] / ⇧⌘[,Ctrl+PageDown / PageUp)、切换分屏窗格(⌥⌘→ / ⌥⌘←,Alt+→ / Alt+←);
// 按键不进 shell;popout 子窗里只在本窗的终端间轮转;编辑器里同键仍切编辑器 tab。BDD: src/__tests__/terminal-focus-cycle/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT, TERMINAL_PANEL_TAB } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const isMac = process.platform === 'darwin';
const NEXT = isMac ? 'Meta+Shift+BracketRight' : 'Control+PageDown';
const PREV = isMac ? 'Meta+Shift+BracketLeft' : 'Control+PageUp';
const NEXT_PANE = isMac ? 'Meta+Alt+ArrowRight' : 'Alt+ArrowRight';
const PREV_PANE = isMac ? 'Meta+Alt+ArrowLeft' : 'Alt+ArrowLeft';
// 方向键 / 括号的 CSI 序列或其残片(按键若漏进 shell 会出现在终端里)
const GARBAGE = /\[1;\d|;\d+[A-D~]|\^\[/;

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

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui134-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui134-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(ws, 'b.ts'), 'export const b = 2;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  await disableFocusEmulation(win);
  return { app, win };
}

const runCommand = (win: Page, id: string): Promise<boolean> =>
  win.evaluate((id) => globalThis.__continuoTest!.executeCommand(id), id);

interface Layout {
  /** 可见 dock 组(按位置:上到下、左到右),每组的终端 tab(面板 id,tab 顺序)与正显示的 tab。 */
  readonly groups: { readonly terminals: string[]; readonly selected: string | null }[];
  /** 焦点所在终端(焦点在终端输入区里)的面板 id。 */
  readonly focused: string | null;
}

const layout = (page: Page): Promise<Layout> =>
  page.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>('.dv-groupview')]
      .map((g) => ({ g, r: g.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .sort((a, b) => Math.round(a.r.top) - Math.round(b.r.top) || a.r.left - b.r.left);
    const out = groups.map(({ g }) => {
      const tabs = [...g.querySelectorAll<HTMLElement>('[role=tab][data-panel-id]')];
      const terminals = tabs
        // 终端面板 id = terminal-<sessionId>(terminal-panel-id)
        .filter((t) => (t.getAttribute('data-panel-id') ?? '').startsWith('terminal-'))
        .map((t) => t.getAttribute('data-panel-id')!);
      const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
      return { terminals, selected: sel?.getAttribute('data-panel-id') ?? null };
    });
    const el = document.activeElement;
    let focused: string | null = null;
    if (el?.closest('[data-co-terminal]')) {
      const g = el.closest('.dv-groupview');
      focused = g?.querySelector('[role=tab][aria-selected=true]')?.getAttribute('data-panel-id') ?? null;
    }
    return { groups: out, focused };
  });

const focusedTerminal = async (page: Page): Promise<string | null> => (await layout(page)).focused;
const activeText = (win: Page): Promise<string> => win.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');

async function newTerminal(win: Page, count: number): Promise<void> {
  expect(await runCommand(win, 'terminal.new')).toBe(true);
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(count, { timeout: 20_000 });
}

/** 点终端 tab 激活并等焦点进入其输入区。 */
async function focusTerminalTab(page: Page, id: string): Promise<void> {
  await page.locator(`[role=tab][data-panel-id="${id}"]`).click();
  await expect.poll(() => focusedTerminal(page), { timeout: 10_000 }).toBe(id);
}

/**
 * 主窗三个终端:t1 | t2 分屏,第三个作为 tab 加进右侧组(窗口收窄,分屏放不下时新终端进参照终端的组)。
 * 返回空间顺序的终端 id 与窗格(正显示终端的组)。
 */
async function threeTerminals(app: ElectronApplication, win: Page): Promise<{ order: string[]; panes: () => Promise<string[]> }> {
  await newTerminal(win, 1);
  await newTerminal(win, 2);
  // 收窄窗口:第三个终端分屏后组宽不足最小宽度 → 作为 tab 加入
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(520, 700));
  await win.waitForTimeout(500);
  await newTerminal(win, 3);
  // 恢复宽度(组头的弹出等按钮在窄组里收进「更多操作」)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
  await win.waitForTimeout(500);
  const l = await layout(win);
  const order = l.groups.flatMap((g) => g.terminals);
  expect(order).toHaveLength(3);
  // 至少两个终端组(分屏),且有一组含两个终端 tab
  expect(l.groups.filter((g) => g.terminals.length > 0).length).toBeGreaterThanOrEqual(2);
  expect(l.groups.some((g) => g.terminals.length === 2)).toBe(true);
  const panes = async () =>
    (await layout(win)).groups.map((g) => g.selected).filter((s): s is string => s !== null && s.startsWith('terminal-'));
  return { order, panes };
}

test('主窗:⇧⌘] / ⇧⌘[ 在三个终端间按空间顺序循环(含同组被遮住的 tab),⌥⌘→ / ⌥⌘← 在分屏窗格间移动;按键不进 shell', async () => {
  test.setTimeout(150_000);
  const { app, win } = await launch();
  const { order, panes } = await threeTerminals(app, win);
  for (const id of order) {
    await focusTerminalTab(win, id);
    await expect.poll(() => activeText(win), { timeout: 15_000 }).not.toBe('');
  }

  await focusTerminalTab(win, order[0]!);
  for (let i = 1; i <= order.length; i++) {
    await win.keyboard.press(NEXT);
    const want = order[i % order.length]!;
    await expect.poll(() => focusedTerminal(win), { timeout: 10_000 }).toBe(want);
    await expect(win.locator(`[role=tab][data-panel-id="${want}"]`)).toHaveAttribute('aria-selected', 'true');
  }
  for (let i = order.length - 1; i >= 0; i--) {
    await win.keyboard.press(PREV);
    await expect.poll(() => focusedTerminal(win), { timeout: 10_000 }).toBe(order[i]!);
  }

  // 窗格:正显示终端的组之间,首尾相接
  const visible = await panes();
  expect(visible.length).toBeGreaterThanOrEqual(2);
  await focusTerminalTab(win, visible[0]!);
  for (let i = 1; i <= visible.length; i++) {
    await win.keyboard.press(NEXT_PANE);
    await expect.poll(() => focusedTerminal(win), { timeout: 10_000 }).toBe(visible[i % visible.length]!);
  }
  await win.keyboard.press(PREV_PANE);
  await expect.poll(() => focusedTerminal(win), { timeout: 10_000 }).toBe(visible[visible.length - 1]!);
  // 正显示的终端没变(窗格移动不切出被遮住的 tab)
  expect(await panes()).toEqual(visible);

  // 每个终端:按键没有漏进 shell(没有方向键 / 括号序列残片),输入照常
  for (const id of order) {
    await focusTerminalTab(win, id);
    await win.keyboard.type('echo ui134-ok');
    await win.keyboard.press('Enter');
    await expect.poll(() => activeText(win), { timeout: 10_000 }).toMatch(/^ui134-ok$/m);
    const text = await activeText(win);
    expect(text).not.toMatch(GARBAGE);
    expect(text).not.toMatch(/[\][}{]\s*echo ui134-ok/);
  }
});

test('只有一个终端窗格时 ⌥⌘→ 不动、不进 shell 乱码;编辑器里 ⇧⌘] / ⇧⌘[ / ⌥⌘→ 仍切编辑器 tab', async () => {
  test.setTimeout(120_000);
  const { win } = await launch();
  await openTreeItem(win, /^a\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('export const a = 1;', { timeout: 10_000 });
  await openTreeItem(win, /^b\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('export const b = 2;', { timeout: 10_000 });
  const activeEditor = () => win.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());

  await newTerminal(win, 1);
  const id = (await layout(win)).groups.flatMap((g) => g.terminals)[0]!;
  await focusTerminalTab(win, id);
  await expect.poll(() => activeText(win), { timeout: 15_000 }).not.toBe('');
  const before = await activeEditor();
  await win.keyboard.press(NEXT_PANE);
  await win.keyboard.press(NEXT);
  await win.waitForTimeout(300);
  expect(await focusedTerminal(win)).toBe(id);
  // 编辑器 tab 没在后台被切换
  expect(await activeEditor()).toBe(before);
  await win.keyboard.type('echo ui134-one');
  await win.keyboard.press('Enter');
  await expect.poll(() => activeText(win), { timeout: 10_000 }).toMatch(/^ui134-one$/m);
  expect(await activeText(win)).not.toMatch(GARBAGE);

  // 编辑器里:原语义(⌃` 从终端回到编辑器)
  await win.keyboard.press('Control+Backquote');
  await expect(win.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => win.evaluate(() => document.activeElement?.closest('.cm-editor') !== null)).toBe(true);
  await expect.poll(() => activeEditor()).toMatch(/b\.ts$/);
  await win.keyboard.press(PREV);
  await expect.poll(() => activeEditor()).toMatch(/a\.ts$/);
  await win.keyboard.press(NEXT);
  await expect.poll(() => activeEditor()).toMatch(/b\.ts$/);
  if (isMac) {
    await win.keyboard.press(PREV_PANE);
    await expect.poll(() => activeEditor()).toMatch(/a\.ts$/);
  }
  expect(await focusedTerminal(win)).toBeNull();
  await expect(win.locator('.cm-content')).toHaveText('export const a = 1;');
});

test('popout 子窗:⇧⌘] / ⇧⌘[ 只在本窗口的终端间轮转 —— 子窗里不跳到主窗,主窗里不跳进子窗', async () => {
  test.setTimeout(150_000);
  const { app, win } = await launch();
  const { order } = await threeTerminals(app, win);
  for (const id of order) {
    await focusTerminalTab(win, id);
    await expect.poll(() => activeText(win), { timeout: 15_000 }).not.toBe('');
  }
  // 弹出一个终端(dock 组头的弹出按钮移走该组的活动面板)
  const popped = order[0]!;
  const tab = win.locator(`[role=tab][data-panel-id="${popped}"]`);
  await tab.click();
  await tab.locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });
  await disableFocusEmulation(child);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1'))?.focus();
  });
  await expect.poll(() => child.evaluate(() => document.hasFocus())).toBe(true);
  expect((await layout(child)).groups.flatMap((g) => g.terminals)).toEqual([popped]);
  const mainTerms = (await layout(win)).groups.flatMap((g) => g.terminals);
  expect(mainTerms).toHaveLength(2);
  expect(mainTerms).not.toContain(popped);

  // 子窗:只有这一个终端 → 不动,主窗的终端不被激活(各组正显示的 tab 不变),焦点留在子窗
  await focusTerminalTab(child, popped);
  const mainSelected = (await layout(win)).groups.map((g) => g.selected);
  for (const key of [NEXT, PREV, NEXT, NEXT_PANE]) {
    await child.keyboard.press(key);
    await child.waitForTimeout(200);
    expect(await focusedTerminal(child)).toBe(popped);
  }
  expect((await layout(win)).groups.map((g) => g.selected)).toEqual(mainSelected);
  await expect.poll(() => child.evaluate(() => document.hasFocus())).toBe(true);
  // 按键没漏进子窗终端的 shell
  await child.keyboard.type('echo ui134-pop');
  await child.keyboard.press('Enter');
  // 活动面板是子窗里的终端(测试钩子在主窗,读 dock 的活动面板)
  await expect.poll(() => activeText(win), { timeout: 10_000 }).toMatch(/^ui134-pop$/m);
  expect(await activeText(win)).not.toMatch(GARBAGE);

  // 主窗:只在主窗的两个终端间轮转,不跳进子窗
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('popout=1'))?.focus();
  });
  await expect.poll(() => win.evaluate(() => document.hasFocus())).toBe(true);
  await focusTerminalTab(win, mainTerms[0]!);
  for (let i = 1; i <= 3; i++) {
    await win.keyboard.press(NEXT);
    await expect.poll(() => focusedTerminal(win), { timeout: 10_000 }).toBe(mainTerms[i % 2]!);
  }
  expect(await child.evaluate(() => document.hasFocus())).toBe(false);
});
