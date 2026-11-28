// 功能入口可发现性(BDD: src/__tests__/entry-discoverability/):
// 1. 应用菜单 文件 → 关闭编辑器 / 显示 → 运行 / 帮助外链(经 main 的 e2e 菜单钩子,与真实点击同一路径;外链不点,只看结构)
// 2. 活动栏「运行和调试」「搜索」打开对应面板
// 3. 状态栏「侧栏已隐藏」点击显示侧栏
// 4. 设置搜索框旁「筛选设置」→「已修改」插入 @modified
// 5. 命令面板搜「keybindings」找到「打开键盘快捷方式」
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { dispatchModKey } from './helpers/hotkeys';
import { commandPaletteInput, COMMAND_LIST } from './helpers/palette';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const DEBUG_TAB = /^(调试|Debug|디버그)$/;
const RUN_DEBUG = /^(运行和调试|Run and Debug|실행 및 디버그)$/;
const SEARCH_BUTTON = /^(搜索|Search|검색)$/;
const SIDEBAR_HIDDEN = /^(侧栏已隐藏|Sidebar hidden|사이드바 숨김)$/;
const FILTER_SETTINGS = /^(筛选设置|Filter Settings|설정 필터)$/;
const FILTER_MODIFIED = /^(已修改|Modified|수정됨)$/;
const SEARCH_SETTINGS = /^(搜索设置|Search settings|설정 검색)/;
const OPEN_KEYBINDINGS = /(打开键盘快捷方式|Open Keyboard Shortcuts|바로 가기 키 열기)/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'entry-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'entry-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'main-file.ts'), 'let main = 1;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByRole('treeitem', { name: /^main-file\.ts$/ })).toBeVisible({ timeout: 15_000 });
  return { app, win };
}

const snapshot = (app: ElectronApplication): Promise<MenuSnapshotItem[]> =>
  app.evaluate(() => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot());

const FILE = process.platform === 'darwin' ? 1 : 0;
const VIEW = process.platform === 'darwin' ? 4 : 3;
const HELP = process.platform === 'darwin' ? 8 : 7;

async function clickMenu(app: ElectronApplication, top: number, id: string): Promise<void> {
  const items = (await snapshot(app))[top]!.submenu!;
  const i = items.findIndex((m) => m.id === id);
  expect(i, id).toBeGreaterThanOrEqual(0);
  const winId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
  const ok = await app.evaluate(
    (_e, { p, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId),
    { p: [top, i], winId },
  );
  expect(ok).toBe(true);
}

test('菜单:文件 → 关闭编辑器关掉活动文件;显示 → 运行打开调试视图;帮助有文档 / 发行说明 / 报告问题', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  await openTreeItem(win, /^main-file\.ts$/);
  const fileTab = win.getByRole('tab', { name: /^main-file\.ts/ });
  await expect(fileTab).toBeVisible({ timeout: 10_000 });
  const mod = process.platform === 'darwin' ? 'Command' : 'Ctrl';
  await expect
    .poll(async () => (await snapshot(app))[FILE]!.submenu!.find((m) => m.id === 'workbench.action.closeActiveEditor')?.accelerator, {
      timeout: 15_000,
    })
    .toBe(`${mod}+W`);
  await clickMenu(app, FILE, 'workbench.action.closeActiveEditor');
  await expect(fileTab).toHaveCount(0, { timeout: 10_000 });

  await clickMenu(app, VIEW, 'workbench.view.debug');
  await expect(win.getByRole('tab', { name: DEBUG_TAB })).toHaveCount(1, { timeout: 10_000 });

  const help = (await snapshot(app))[HELP]!.submenu!.filter((m) => m.type !== 'separator').map((m) => m.label);
  expect(help).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^(文档|Documentation|설명서)$/),
      expect.stringMatching(/^(显示发行说明|Show Release Notes|릴리스 정보 표시)$/),
      expect.stringMatching(/^(报告问题|Report Issue|문제 보고)$/),
    ]),
  );
});

test('活动栏「运行和调试」打开调试视图、「搜索」打开搜索并聚焦查询框;状态栏「侧栏已隐藏」点击显示侧栏', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const activityBar = win.locator('main aside').first();
  await activityBar.getByRole('button', { name: RUN_DEBUG }).click();
  await expect(win.getByRole('tab', { name: DEBUG_TAB })).toHaveCount(1, { timeout: 10_000 });
  await activityBar.getByRole('button', { name: SEARCH_BUTTON }).click();
  await expect(win.getByRole('textbox', { name: /^(搜索|Search|검색)$/ })).toBeFocused({ timeout: 10_000 });

  await dispatchModKey(win, 'b');
  const hidden = win.locator('footer').getByRole('button', { name: SIDEBAR_HIDDEN });
  await expect(hidden).toBeVisible({ timeout: 10_000 });
  await expect(hidden).toHaveAttribute('title', /\((⌘B|Ctrl\+B)\)$/);
  await hidden.click();
  await expect(hidden).toHaveCount(0);
  await expect(win.getByRole('treeitem', { name: /^main-file\.ts$/ })).toBeVisible();
});

test('设置「筛选设置」→「已修改」插入 @modified;命令面板搜 keybindings 找到「打开键盘快捷方式」', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await dispatchModKey(win, ',');
  const search = win.getByRole('textbox', { name: SEARCH_SETTINGS });
  await expect(search).toBeVisible({ timeout: 10_000 });
  await win.getByRole('button', { name: FILTER_SETTINGS }).click();
  await win.getByRole('menuitemcheckbox', { name: FILTER_MODIFIED }).click();
  await expect(search).toHaveValue('@modified');
  await expect(search).toBeFocused();

  await dispatchModKey(win, 'p', { shift: true });
  await expect(commandPaletteInput(win)).toBeVisible({ timeout: 5_000 });
  await commandPaletteInput(win).fill('keybindings');
  await expect(win.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').filter({ hasText: OPEN_KEYBINDINGS })).toBeVisible();
});
