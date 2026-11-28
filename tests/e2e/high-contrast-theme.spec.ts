// 高对比度深色 / 浅色主题(BDD: src/__tests__/high-contrast-theme/):
//   1. 设置页切到 HC 深 / 浅:<html> class、画布 / 输入框边框 / 编辑器当前行 / 对话框边框按 HC(终端截图核对);重启保留(窗口底色也是 HC)
//   2. 跟随系统:CDP 模拟 prefers-contrast: more / forced-colors: active(+ prefers-color-scheme)→ 自动切 HC 深 / 浅;
//      main 侧 nativeTheme 高对比度(e2e 下改 nativeTheme 属性 + emit 'updated' 注入,不改系统设置)→ 同样切
// 截图放 UI186_SHOTS_DIR(未设置则不截)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { openTreeItem, dockHeaderMoreActionsButton } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { CLOSE_SETTINGS, SETTINGS, SETTINGS_NAV, TERMINAL_TAB } from './helpers/settings';
import { TERMINAL_INPUT } from './helpers/editor';
import { commandPaletteInput } from './helpers/palette';
import { dispatchModKey } from './helpers/hotkeys';

const TMP_ROOT = '/private/tmp/claude-501';
const SHOTS = process.env['UI186_SHOTS_DIR'];
const HC_DARK = /^(高对比度深色|Dark High Contrast|고대비 다크)$/;
const HC_LIGHT = /^(高对比度浅色|Light High Contrast|고대비 라이트)$/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(kind: string): string {
  const dir = mkdtempSync(path.join(TMP_ROOT, `ui186-${kind}-`));
  dirs.push(dir);
  return dir;
}

async function launch(ud: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForAppReady(win);
  await waitForTestHooks(win);
  return { app, win };
}

const themeClasses = (win: Page): Promise<string[]> =>
  win.evaluate(() => ['dark', 'hc-black', 'hc-light'].filter((c) => document.documentElement.classList.contains(c)));
const css = (win: Page, selector: string, prop: string): Promise<string> =>
  win.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
const setSetting = (win: Page, id: string, v: string): Promise<void> =>
  win.evaluate(([k, val]) => globalThis.__continuoTest!.setSettingValue(k as string, val as string), [id, v] as const);

async function shot(win: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await win.waitForTimeout(250);
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function openSettings(win: Page): Promise<void> {
  await win.getByRole('button', { name: SETTINGS }).click();
  await expect(win.getByRole('navigation', { name: SETTINGS_NAV })).toBeVisible({ timeout: 10_000 });
}

async function openTerminal(win: Page): Promise<void> {
  await dockHeaderMoreActionsButton(win).click();
  await win.getByRole('menu').last().getByRole('menuitem', { name: TERMINAL_TAB }).click();
  await expect(win.getByRole('textbox', { name: TERMINAL_INPUT })).toBeAttached({ timeout: 15_000 });
}

test('设置页切到高对比度深 / 浅:界面 / 编辑器 / 终端 / 对话框按 HC 绘制;重启保留', async () => {
  test.setTimeout(180_000);
  const ud = tempDir('ud');
  const ws = tempDir('ws');
  writeFileSync(path.join(ws, 'main.ts'), 'export function add(a: number, b: number): number {\n  // sum\n  return a + b;\n}\n');
  seedExplorerJson(ud, { root: ws });
  let { app, win } = await launch(ud);
  expect(await themeClasses(win)).toEqual(['dark']);

  await openTreeItem(win, /^main\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('export function add', { timeout: 10_000 });
  await win.locator('.cm-content').click();
  await openTerminal(win);
  await win.getByRole('textbox', { name: TERMINAL_INPUT }).focus();
  await win.keyboard.type("printf '\\e[34mblue\\e[0m \\e[90mdim\\e[0m \\e[31mred\\e[0m\\n'");
  await win.keyboard.press('Enter');

  for (const [label, cls, surface, contrastBorder, activeBorder, name] of [
    [HC_DARK, ['dark', 'hc-black'], 'rgb(0, 0, 0)', 'rgb(111, 195, 223)', 'rgb(243, 133, 24)', 'hc-dark'],
    [HC_LIGHT, ['hc-light'], 'rgb(255, 255, 255)', 'rgb(15, 74, 133)', 'rgb(0, 107, 189)', 'hc-light'],
  ] as const) {
    await openSettings(win);
    await win.locator('button, [role=radio], [role=tab]').filter({ hasText: label }).first().click();
    await expect.poll(() => themeClasses(win)).toEqual(cls);
    await expect.poll(() => css(win, 'body', 'background-color')).toBe(surface);
    // 输入框(设置搜索)与分段控件外框 = contrastBorder
    await expect.poll(() => css(win, '.wm-input', 'border-top-color')).toBe(contrastBorder);
    await expect.poll(() => css(win, '.wm-segmented', 'border-top-color')).toBe(contrastBorder);
    // 选中的主题项:contrastActiveBorder 轮廓
    await expect.poll(() => css(win, '.wm-segmented-option[data-active="true"]', 'outline-color')).toBe(activeBorder);
    await shot(win, `${name}-settings`);
    await win.getByRole('button', { name: CLOSE_SETTINGS }).click();

    // 编辑器当前行:无底色 + contrastActiveBorder 边框(dock 第 1 个 tab 是编辑器组,第 2 个是终端)
    const dockTabs = win.locator('.dv-tab [role="tab"]');
    await dockTabs.nth(0).click();
    await win.locator('.cm-content').click();
    await expect.poll(() => css(win, '.cm-activeLine', 'outline-color')).toBe(activeBorder);
    expect(await css(win, '.cm-activeLine', 'background-color')).toBe('rgba(0, 0, 0, 0)');
    await shot(win, `${name}-editor`);
    // 终端底色 = HC 画布色
    // 终端:换 HC 配色(xterm 画在 canvas 上,配色映射由 hc-terminal.spec 断言;此处截图核对)
    await dockTabs.nth(1).click();
    await expect(win.locator('.xterm')).toBeVisible();
    await shot(win, `${name}-terminal`);

    // 对话框(命令面板):contrastBorder 边框
    await dispatchModKey(win, 'p', { shift: true });
    await expect(commandPaletteInput(win)).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => css(win, '.wm-modal-content', 'border-top-color')).toBe(contrastBorder);
    await shot(win, `${name}-dialog`);
    await commandPaletteInput(win).press('Escape');
  }

  // 重启保留(设置值 + 窗口底色)
  await closeDiscardingUnsaved(app);
  apps.splice(apps.indexOf(app), 1);
  ({ app, win } = await launch(ud));
  expect(await themeClasses(win)).toEqual(['hc-light']);
  const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor());
  expect(bg?.toLowerCase()).toMatch(/^#(ff)?ffffff$/);
});

test('跟随系统:系统高对比度(CDP 模拟媒体查询 / main nativeTheme 注入)→ 自动切 HC 深 / 浅,关掉即恢复', async () => {
  test.setTimeout(120_000);
  const ud = tempDir('ud');
  const { app, win } = await launch(ud);
  const cdp = await win.context().newCDPSession(win);
  const emulate = (features: Array<{ name: string; value: string }>) =>
    cdp.send('Emulation.setEmulatedMedia', { features });

  await emulate([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await setSetting(win, 'general.theme', 'system');
  await expect.poll(() => themeClasses(win)).toEqual(['dark']);

  await emulate([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-contrast', value: 'more' },
  ]);
  await expect.poll(() => themeClasses(win)).toEqual(['dark', 'hc-black']);
  await shot(win, 'system-prefers-contrast-dark');

  await emulate([
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'forced-colors', value: 'active' },
  ]);
  await expect.poll(() => themeClasses(win)).toEqual(['hc-light']);

  await emulate([{ name: 'prefers-color-scheme', value: 'light' }]);
  await expect.poll(() => themeClasses(win)).toEqual([]);

  // main 侧:nativeTheme 判定为高对比度(macOS「增强对比度」/ Windows 高对比度 / Linux)→ 广播 → 切 HC
  await app.evaluate(({ nativeTheme }) => {
    const keys = ['shouldUseHighContrastColors', 'shouldUseInvertedColorScheme', 'shouldUseDarkColors'] as const;
    // 记住原访问器(可能是实例自有属性),恢复时放回
    (globalThis as unknown as { __ui186Orig: unknown }).__ui186Orig = keys.map((k) => [
      k,
      Object.getOwnPropertyDescriptor(nativeTheme, k),
    ]);
    for (const k of keys) Object.defineProperty(nativeTheme, k, { configurable: true, get: () => true });
    nativeTheme.emit('updated');
  });
  await expect.poll(() => themeClasses(win)).toEqual(['dark', 'hc-black']);
  // 新窗口底色(system 模式按 OS 配色)= HC 深画布色
  const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor());
  expect(bg?.toLowerCase()).toMatch(/^#(ff)?000000$/);

  await app.evaluate(({ nativeTheme }) => {
    const orig = (globalThis as unknown as { __ui186Orig: Array<[string, PropertyDescriptor | undefined]> }).__ui186Orig;
    for (const [k, desc] of orig) {
      if (desc) Object.defineProperty(nativeTheme, k, desc);
      else delete (nativeTheme as unknown as Record<string, unknown>)[k];
    }
    nativeTheme.emit('updated');
  });
  await expect.poll(() => themeClasses(win)).toEqual([]);
});
