// 拆分终端(VSCode workbench.action.terminal.split):终端获焦时 ⌘\ / Ctrl+Shift+5 在当前终端右侧拆出新终端(不拆编辑器、
// 不进 shell),焦点进新终端、cwd 继承父终端;终端右键菜单 / 「终端」菜单 / 命令面板都有入口。BDD: src/__tests__/terminal-split/
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { TERMINAL_PANEL_TAB } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { commandPaletteInput, openCommandPalette } from './helpers/palette';
import type { AppMenuE2eHook } from '../../electron/main/app-menu-e2e';

const isMac = process.platform === 'darwin';
const SPLIT_KEY = isMac ? 'Meta+Backslash' : 'Control+Shift+Digit5';
const SPLIT_LABEL = /^(拆分终端|Split Terminal|터미널 분할)/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page; ws: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'split-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'split-ws-'));
  dirs.push(ud, ws);
  mkdirSync(path.join(ws, 'sub'));
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return { app, win, ws };
}

interface Layout {
  /** 可见 dock 组(左到右)的终端 tab。 */
  readonly groups: string[][];
  /** 焦点所在终端的面板 id。 */
  readonly focused: string | null;
}

const layout = (page: Page): Promise<Layout> =>
  page.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>('.dv-groupview')]
      .map((g) => ({ g, r: g.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0)
      .sort((a, b) => a.r.left - b.r.left || a.r.top - b.r.top)
      .map(({ g }) =>
        [...g.querySelectorAll<HTMLElement>('[role=tab][data-panel-id]')]
          .map((t) => t.getAttribute('data-panel-id')!)
          .filter((id) => id.startsWith('terminal-')),
      )
      .filter((ids) => ids.length > 0);
    const el = document.activeElement;
    const focused = el?.closest('[data-co-terminal]')
      ? (el.closest('.dv-groupview')?.querySelector('[role=tab][aria-selected=true]')?.getAttribute('data-panel-id') ?? null)
      : null;
    return { groups, focused };
  });

const activeText = (win: Page): Promise<string> => win.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');

async function focusTerminal(win: Page, id: string): Promise<void> {
  await win.locator(`[role=tab][data-panel-id="${id}"]`).click();
  await expect.poll(async () => (await layout(win)).focused, { timeout: 10_000 }).toBe(id);
}

test('终端获焦时拆分键在当前终端右侧拆出新终端:焦点进新终端、cwd 继承、按键不进 shell;右键 / 菜单 / 命令面板入口', async () => {
  test.setTimeout(120_000);
  const { app, win, ws } = await launch();
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1, { timeout: 20_000 });
  const [first] = (await layout(win)).groups.flat();
  await focusTerminal(win, first!);
  await expect.poll(() => activeText(win), { timeout: 15_000 }).not.toBe('');
  // 父终端 cd 进子目录(zsh 经 OSC 7 上报 cwd)
  await win.keyboard.type('cd sub && printf "%s\\n" READY');
  await win.keyboard.press('Enter');
  await expect.poll(() => activeText(win), { timeout: 10_000 }).toMatch(/^READY$/m);
  await win.waitForTimeout(800);

  await win.keyboard.press(SPLIT_KEY);
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(2, { timeout: 20_000 });
  const second = await expect
    .poll(async () => (await layout(win)).groups, { timeout: 10_000 })
    .toHaveLength(2)
    .then(() => layout(win));
  const newId = second.groups[1]![0]!;
  expect(second.groups[0]).toEqual([first]);
  await expect.poll(async () => (await layout(win)).focused, { timeout: 10_000 }).toBe(newId);
  // 编辑器没有被拆分(没有新的编辑器组)、拆分键没进父终端的 shell
  expect(await win.locator('.dv-groupview').evaluateAll((gs) => gs.filter((g) => g.getBoundingClientRect().width > 0).length)).toBe(2);
  await expect.poll(() => activeText(win), { timeout: 15_000 }).not.toBe('');
  await win.keyboard.type('pwd');
  await win.keyboard.press('Enter');
  await expect.poll(() => activeText(win), { timeout: 10_000 }).toMatch(new RegExp(`${path.basename(ws)}/sub$`, 'm'));
  await focusTerminal(win, first!);
  const parentText = await activeText(win);
  expect(parentText).not.toContain('\u001c');
  expect(parentText).not.toMatch(/\^\\/);

  // 右键父终端「拆分终端」(带键位)→ 新终端紧挨父终端右侧(不是追加到最右)
  await win.locator(`[role=tab][data-panel-id="${first}"]`).click();
  const host = win.locator('[data-testid=terminal-panel-view-xterm-host]').first();
  await host.click({ button: 'right' });
  const item = win.getByRole('menuitem', { name: SPLIT_LABEL });
  await expect(item).toBeVisible();
  await expect(item).toContainText(isMac ? '⌘\\' : 'Ctrl+Shift+5');
  await item.click();
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(3, { timeout: 20_000 });
  await expect.poll(async () => (await layout(win)).groups.length, { timeout: 10_000 }).toBe(3);
  const third = await layout(win);
  expect(third.groups[0]).toEqual([first]);
  expect(third.groups[2]).toEqual([newId]);
  await expect.poll(async () => (await layout(win)).focused, { timeout: 10_000 }).toBe(third.groups[1]![0]);

  // 「终端」菜单:新建终端之后是拆分终端,显示键位;点它拆分当前终端(E2E 下应用菜单为 null,经 main 的 __continuoAppMenu 钩子)
  const menu = await app.evaluate(() => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot());
  const top = menu.findIndex((m) => m.submenu?.some((s) => s.id === 'terminal.new'));
  const items = menu[top]!.submenu!;
  expect(items.map((m) => m.id).slice(0, 2)).toEqual(['terminal.new', 'workbench.action.terminal.split']);
  expect(items[1]!.label).toMatch(SPLIT_LABEL);
  expect(items[1]!.accelerator).toMatch(isMac ? /\\$/ : /Shift\+5$/);
  const winId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
  expect(
    await app.evaluate(
      (_e, { top, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click([top, 1], winId),
      { top, winId },
    ),
  ).toBe(true);
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(4, { timeout: 20_000 });

  // 命令面板可搜
  await openCommandPalette(win);
  await commandPaletteInput(win).fill('Split Terminal');
  await expect(win.getByRole('option', { name: /(拆分终端|Split Terminal|터미널 분할)/ }).first()).toBeVisible();
});
