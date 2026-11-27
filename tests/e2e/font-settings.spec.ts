// 编辑器 / 终端字体族与行高(BDD: src/__tests__/font-settings/)。
// 1. 设置页可见(搜 id)、改编辑器字体 / 行高 → 代码编辑器计算样式即时变化;恢复默认 → 回到默认;popout 子窗里的编辑器同样生效
// 2. 改终端字体 / 行高 → xterm 单元格尺寸变化、行列数随之重排(stty size),输出照常可读
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { CLOSE_SETTINGS, openSettings, RESET_DEFAULT_TEXT, settingsSearch } from './helpers/settings';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FONT_FAMILY_SETTING = /^(字体|Font family|글꼴)$/;
const editorRoots = (page: Page) => page.locator('[data-editor-panel-root]');
const setSetting = (page: Page, id: string, v: string | number) =>
  page.evaluate(([id, v]) => globalThis.__continuoTest!.setSettingValue(id as string, v as string | number), [id, v] as const);

/** 代码编辑器 `.cm-line` 的计算字体 / 行高。 */
const editorStyle = (page: Page) =>
  editorRoots(page)
    .locator('.cm-line')
    .first()
    .evaluate((el) => ({ font: getComputedStyle(el).fontFamily, lineHeight: getComputedStyle(el).lineHeight }));

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui108-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui108-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await waitForAppReady(win);
  await waitForTestHooks(win);
  return { app, win };
}

test('编辑器字体 / 行高:设置页可改,代码编辑器即时生效,恢复默认;popout 子窗同样生效', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  await openTreeItem(win, /^a\.ts$/);
  await expect(editorRoots(win).locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  const initial = await editorStyle(win);
  expect(initial.font).toContain('ui-monospace');

  // 设置页搜 id → 字体输入框;键入即写入设置(设置面板占着编辑器所在位置 → 关掉设置再看编辑器)
  const findInput = async () => {
    await openSettings(win);
    await settingsSearch(win).fill('editor.fontFamily');
    // 搜索结果只此一项:输入框可访问名 = 设置标题「字体」
    const main = win.locator('main');
    await expect(main.locator('code', { hasText: /^editor\.fontFamily$/ })).toBeVisible({ timeout: 5_000 });
    return { main, input: main.getByRole('textbox', { name: FONT_FAMILY_SETTING }) };
  };
  const closeSettings = () => win.getByRole('button', { name: CLOSE_SETTINGS }).click();
  let { main, input } = await findInput();
  await expect(input).toHaveValue(/ui-monospace/);
  await input.fill('"Courier New", monospace');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest!.getSettingValue('editor.fontFamily'))).toBe(
    '"Courier New", monospace',
  );
  await closeSettings();
  await expect.poll(async () => (await editorStyle(win)).font).toContain('Courier New');

  // 行高:2(倍数)→ 13px × 2 = 26px;30(像素)→ 30px;0(自动)→ 默认
  await setSetting(win, 'editor.lineHeight', 2);
  await expect.poll(async () => (await editorStyle(win)).lineHeight).toBe('26px');
  await setSetting(win, 'editor.lineHeight', 30);
  await expect.poll(async () => (await editorStyle(win)).lineHeight).toBe('30px');
  await setSetting(win, 'editor.lineHeight', 0);
  await expect.poll(async () => (await editorStyle(win)).lineHeight).toBe(initial.lineHeight);

  // 恢复默认 → 回到默认字体
  ({ main, input } = await findInput());
  await main.getByRole('button', { name: RESET_DEFAULT_TEXT }).click();
  await expect(input).toHaveValue(/ui-monospace/);
  await closeSettings();
  await expect.poll(async () => (await editorStyle(win)).font).toBe(initial.font);

  // popout 子窗:编辑器组弹出后改设置,子窗里的编辑器即时跟随(子窗经设置跨窗同步写自己的 <html> 变量)
  await editorRoots(win).locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  await expect(editorRoots(child).locator('.cm-content')).toContainText('export const a', { timeout: 10_000 });
  await setSetting(win, 'editor.fontFamily', 'Georgia');
  await setSetting(win, 'editor.lineHeight', 24);
  await expect.poll(async () => (await editorStyle(child)).font).toContain('Georgia');
  await expect.poll(async () => (await editorStyle(child)).lineHeight).toBe('24px');
});

/** 活动终端缓冲区文本。 */
const terminalText = (page: Page) => page.evaluate(() => globalThis.__continuoTest!.readActiveTerminalText() ?? '');

/** 跑 `stty size` 取 PTY 行列数,并量 xterm 屏幕元素算单元格尺寸。 */
async function terminalGeometry(page: Page, marker: string): Promise<{ rows: number; cols: number; cellW: number; cellH: number }> {
  await page.keyboard.type(`echo ${marker}; stty size\n`);
  let size: [number, number] = [0, 0];
  await expect
    .poll(async () => {
      const text = await terminalText(page);
      const at = text.lastIndexOf(`${marker}\n`);
      const m = at < 0 ? null : /^(\d+) (\d+)$/m.exec(text.slice(at + marker.length + 1));
      size = m ? [Number(m[1]), Number(m[2])] : [0, 0];
      return size[0];
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const box = (await page.locator('[data-testid=terminal-panel-view-xterm-host] .xterm-screen').boundingBox())!;
  const [rows, cols] = size;
  return { rows, cols, cellW: box.width / cols, cellH: box.height / rows };
}

test('终端字体 / 行高:改设置后单元格尺寸变化、行列数重排,输出照常可读', async () => {
  test.setTimeout(120_000);
  const { win } = await launch();
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('terminal.new'))).toBe(true);
  await expect(win.locator('[data-testid=terminal-panel-view-xterm-host] .xterm-screen')).toBeVisible({ timeout: 15_000 });
  await win.locator('[data-testid=terminal-panel-view-xterm-host]').click();
  const base = await terminalGeometry(win, 'G0');

  // 行高 2 → 单元格高约翻倍,行数约减半
  await setSetting(win, 'terminal.integrated.lineHeight', 2);
  await expect.poll(async () => (await terminalGeometry(win, 'G1')).cellH, { timeout: 20_000 }).toBeGreaterThan(base.cellH * 1.7);
  const tall = await terminalGeometry(win, 'G2');
  expect(tall.rows).toBeLessThan(base.rows * 0.65);
  await setSetting(win, 'terminal.integrated.lineHeight', 1);

  // 字体换成比例字体 Arial(字符宽按 'W' 量,明显宽于等宽字体)→ 单元格变宽、列数变少
  await setSetting(win, 'terminal.integrated.fontFamily', 'Arial');
  await expect.poll(async () => (await terminalGeometry(win, 'G3')).cellW, { timeout: 20_000 }).toBeGreaterThan(base.cellW * 1.2);
  const wide = await terminalGeometry(win, 'G4');
  expect(wide.cols).toBeLessThan(base.cols);
  expect(await terminalText(win)).toContain('G4');

  // 清空终端字体 → 跟随编辑器字体;编辑器也是默认 → 回到终端默认字体链,单元格宽度复原
  await setSetting(win, 'terminal.integrated.fontFamily', '');
  await expect.poll(async () => Math.abs((await terminalGeometry(win, 'G5')).cellW - base.cellW), { timeout: 20_000 }).toBeLessThan(0.5);
});
