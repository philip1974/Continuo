// 演示 / 屏幕共享(BDD: src/__tests__/screencast-mode/、font-zoom/、editor-cursor-options/、workbench-layout-visibility/):
// 1. 开发者: 切换屏幕录制模式 → 按 ⌘P → 窗口底部浮出「转到文件… ⌘P」,随后淡出;鼠标按下处显示圆圈,松开消失
// 2. 放大编辑器字体:编辑器字号 ×1.1,不改 editor.fontSize 设置;线形光标默认 2px
// 3. 隐藏状态栏 / 活动栏(命令 + 显示 › 外观菜单勾选),重启后保持;命令面板能找到最大化编辑器组、切换全屏(带默认键)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { COMMAND_LIST, commandPaletteInput, openCommandPalette } from './helpers/palette';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const IS_MAC = process.platform === 'darwin';
const VIEW = IS_MAC ? 4 : 3;
const GO_TO_FILE = /(转到文件…|Go to File…|파일로 이동…)/;

let userData = '';
let workspace = '';
let app: ElectronApplication | null = null;

test.beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'ui201-ud-'));
  workspace = mkdtempSync(path.join(tmpdir(), 'ui201-ws-'));
  writeFileSync(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
  seedExplorerJson(userData, { root: workspace });
});

test.afterEach(async () => {
  if (app) await closeDiscardingUnsaved(app).catch(() => undefined);
  app = null;
  rmSync(userData, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; main: Page }> {
  const a = await launchContinuo(userData);
  app = a;
  const main = await a.firstWindow();
  // 活动栏可能被隐藏(不能等设置按钮):等 dock 区域与测试钩子
  await expect(main.locator('[data-workbench-part="dock"]')).toBeVisible({ timeout: 15_000 });
  await main.waitForFunction(() => !!globalThis.__continuoTest?.executeCommand, null, { timeout: 15_000 });
  const cdp = await main.context().newCDPSession(main);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return { app: a, main };
}

async function runFromPalette(main: Page, query: string, title: RegExp): Promise<void> {
  await openCommandPalette(main);
  await commandPaletteInput(main).fill(query);
  const option = main.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').filter({ hasText: title }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(commandPaletteInput(main)).toBeHidden();
}

const menuSnapshot = (a: ElectronApplication): Promise<MenuSnapshotItem[]> =>
  a.evaluate(() => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot());

/** 显示 › 外观 子菜单在显示菜单里的下标与子项。 */
async function appearanceMenu(a: ElectronApplication): Promise<{ index: number; items: readonly MenuSnapshotItem[] }> {
  const view = (await menuSnapshot(a))[VIEW]!.submenu ?? [];
  const index = view.findIndex((m) => m.submenu?.some((c) => c.id === 'workbench.action.toggleFullScreen'));
  expect(index).toBeGreaterThan(-1);
  return { index, items: view[index]!.submenu! };
}

async function clickAppearanceItem(a: ElectronApplication, id: string): Promise<void> {
  const { index, items } = await appearanceMenu(a);
  const i = items.findIndex((m) => m.id === id);
  expect(i).toBeGreaterThan(-1);
  const winId = await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0]!.id);
  const ok = await a.evaluate(
    (_e, { p, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId),
    { p: [VIEW, index, i], winId },
  );
  expect(ok).toBe(true);
}

test('屏幕录制模式:⌘P → 底部显示命令名与键位并淡出;鼠标按下处显示圆圈', async () => {
  test.setTimeout(90_000);
  const { main } = await launch();
  await runFromPalette(main, 'screencast', /(切换屏幕录制模式|Toggle Screencast Mode|스크린캐스트 모드 전환)/);

  // 浮层 chunk 懒加载:挂上(空、不可见)后再按键
  const overlay = main.locator('[data-screencast-keyboard]');
  await expect(overlay).toHaveAttribute('data-visible', 'false');
  await main.keyboard.press('ControlOrMeta+KeyP');
  await expect(overlay).toHaveAttribute('data-visible', 'true');
  await expect(overlay).toContainText(GO_TO_FILE);
  await expect(overlay.locator('kbd.wm-keycap')).toHaveText(IS_MAC ? '⌘P' : 'Ctrl+P');
  // 浮层盖在 Quick Open 对话框之上、不挡点击;淡出有过渡(0.3s)
  const style = await overlay.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { pointerEvents: cs.pointerEvents, zIndex: Number(cs.zIndex), transition: cs.transitionDuration };
  });
  expect(style.pointerEvents).toBe('none');
  expect(style.zIndex).toBeGreaterThan(9999);
  expect(style.transition).toBe('0.3s');
  // 默认 800ms 后淡出
  await expect(overlay).toHaveAttribute('data-visible', 'false', { timeout: 3_000 });
  await main.keyboard.press('Escape');

  // 鼠标:按下显示圆圈(以按下点为圆心),松开消失
  await main.mouse.move(300, 200);
  await main.mouse.down();
  const marker = main.locator('[data-screencast-mouse]');
  await expect(marker).toBeVisible();
  const box = await marker.boundingBox();
  expect(box && Math.round(box.x + box.width / 2)).toBe(300);
  expect(box && Math.round(box.y + box.height / 2)).toBe(200);
  await main.mouse.up();
  await expect(marker).toHaveCount(0);

  // 再次切换 → 关闭,按键不再显示
  await main.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.toggleScreencastMode'));
  await main.keyboard.press('ControlOrMeta+KeyP');
  await expect(overlay).toHaveCount(0);
  await main.keyboard.press('Escape');
});

test('放大编辑器字体只临时放大(不改设置);线形光标默认 2px', async () => {
  test.setTimeout(90_000);
  const { main } = await launch();
  await main.getByRole('treeitem', { name: 'a.ts' }).click();
  const content = main.locator('.cm-content').first();
  await expect(content).toBeVisible({ timeout: 15_000 });
  const fontSize = (): Promise<string> => content.evaluate((el) => getComputedStyle(el).fontSize);
  expect(await fontSize()).toBe('13px');

  await runFromPalette(main, 'editor font', /(放大编辑器字体|Increase Editor Font Size|편집기 글꼴 크기 늘리기)/);
  await expect.poll(fontSize).toBe('14.3px');
  expect(await main.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.fontSize'))).toBeUndefined();
  await main.evaluate(() => globalThis.__continuoTest!.executeCommand('editor.action.fontZoomReset'));
  await expect.poll(fontSize).toBe('13px');

  await content.click();
  const cursor = main.locator('.cm-cursor-primary').first();
  await expect(cursor).toBeVisible();
  expect(await cursor.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('2px');
  // 改设置 editor.cursorWidth / cursorStyle 即时生效
  await main.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.cursorWidth', 3));
  await expect.poll(() => cursor.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe('3px');
  await main.evaluate(() => globalThis.__continuoTest!.setSettingValue('editor.cursorStyle', 'underline'));
  await expect
    .poll(() => cursor.evaluate((el) => [getComputedStyle(el).borderBottomWidth, getComputedStyle(el).borderLeftStyle]))
    .toEqual(['2px', 'none']);
});

test('隐藏状态栏 / 活动栏(命令 + 外观菜单),重启后保持;命令面板列出最大化编辑器组与切换全屏(带键位)', async () => {
  test.setTimeout(120_000);
  let { app: a, main } = await launch();
  const statusBar = (p: Page) => p.locator('footer[data-statusbar]');
  const activityBar = (p: Page) => p.getByRole('button', { name: /^(设置|Settings|설정)$/ });
  await expect(statusBar(main)).toBeVisible();
  await expect(activityBar(main)).toBeVisible();

  // 外观菜单:全屏显示默认键,状态栏 / 活动栏勾选
  let { items } = await appearanceMenu(a);
  expect(items.find((m) => m.id === 'workbench.action.toggleFullScreen')?.accelerator).toBe(IS_MAC ? 'Command+Control+F' : 'F11');
  expect(items.find((m) => m.id === 'workbench.action.toggleStatusbarVisibility')?.checked).toBe(true);

  await runFromPalette(main, 'status bar', /(切换状态栏可见性|Toggle Status Bar Visibility|상태 표시줄 표시 전환)/);
  await expect(statusBar(main)).toHaveCount(0);
  await clickAppearanceItem(a, 'workbench.action.toggleActivityBarVisibility');
  await expect(activityBar(main)).toHaveCount(0);
  await expect.poll(async () => (await appearanceMenu(a)).items.find((m) => m.id === 'workbench.action.toggleStatusbarVisibility')?.checked).toBe(false);

  await a.close();
  app = null;
  ({ app: a, main } = await launch());
  await expect(statusBar(main)).toHaveCount(0);
  await expect(activityBar(main)).toHaveCount(0);

  // 命令面板:最大化编辑器组(无默认键)、切换全屏(⌃⌘F / F11)。活动栏隐藏(openCommandPalette 要等设置按钮)→ 直接按 ⇧⌘P
  await main.keyboard.press('ControlOrMeta+Shift+KeyP');
  await expect(commandPaletteInput(main)).toBeVisible();
  const options = main.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option');
  await commandPaletteInput(main).fill('maximize editor group');
  await expect(options.filter({ hasText: /(切换最大化编辑器组|Toggle Maximize Editor Group|편집기 그룹 최대화 전환)/ })).toHaveCount(1);
  await commandPaletteInput(main).fill('full screen');
  const fullScreen = options.filter({ hasText: /(切换全屏|Toggle Full Screen|전체 화면 토글)/ }).first();
  await expect(fullScreen).toBeVisible();
  await expect(fullScreen.locator('kbd.wm-keycap')).toHaveText(IS_MAC ? ['⌃', '⌘', 'F'] : ['F11']);
  await main.keyboard.press('Escape');

  // 显示回来(菜单 / 命令)
  await clickAppearanceItem(a, 'workbench.action.toggleStatusbarVisibility');
  await expect(statusBar(main)).toBeVisible();
  await main.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.toggleActivityBarVisibility'));
  await expect(activityBar(main)).toBeVisible();
  ({ items } = await appearanceMenu(a));
  expect(items.find((m) => m.id === 'workbench.action.toggleActivityBarVisibility')?.checked).toBe(true);
});
