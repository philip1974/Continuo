// 后退 / 前进(VSCode workbench.action.navigateBack / navigateForward;mac ⌃- / ⌃⇧-,Windows / Linux Alt+← / Alt+→):
// ⌘P 换文件后回到原文件原光标再前进;⌃G 跳远后回到原行;后退后新导航清掉前进部分。
// BDD: src/__tests__/editor-navigation-history/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { QUICK_OPEN_SEARCH } from './helpers/palette';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isMac = process.platform === 'darwin';
const BACK = isMac ? 'Control+Minus' : 'Alt+ArrowLeft';
const FORWARD = isMac ? 'Control+Shift+Minus' : 'Alt+ArrowRight';
const LINES = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`);

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui98c-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui98c-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'big.ts'), LINES.join('\n'));
  writeFileSync(path.join(ws, 'other.ts'), 'export const other = 1;\n');
  writeFileSync(path.join(ws, 'third.ts'), 'export const third = 3;\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 关掉 Playwright 的焦点模拟:按真实焦点断言
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await openTreeItem(win, /^big\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('const line1 = 1;', { timeout: 10_000 });
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Home');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line1 = 1;');
  return win;
}

/** ⌘P 打开文件。 */
async function quickOpen(win: Page, name: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+p');
  const input = win.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();
  await input.fill(name);
  await expect(win.getByRole('option', { name: new RegExp(name.replace('.', '\\.')) }).first()).toBeVisible();
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
}

/** ⌃G 跳到第 line 行。 */
async function gotoLine(win: Page, line: number): Promise<void> {
  await win.keyboard.press('Control+g');
  const input = win.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toHaveValue(':');
  await win.keyboard.type(String(line));
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(win.locator('.cm-activeLine')).toHaveText(`const line${line} = ${line};`);
}

test('⌘P 换文件后 ⌃- 回到原文件的原光标,⌃⇧- 再前进;编辑器获焦', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await gotoLine(win, 120);
  await quickOpen(win, 'other.ts');
  await expect(win.locator('.cm-content')).toContainText('export const other = 1;');

  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-content')).toContainText('const line120 = 120;');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line120 = 120;');
  await expect(win.locator('.cm-content')).toBeFocused();

  await win.keyboard.press(FORWARD);
  await expect(win.locator('.cm-content')).toContainText('export const other = 1;');
  await expect(win.locator('.cm-content')).toBeFocused();
});

test('⌃G 跳远后 ⌃- 回到原行,⌃⇧- 回到跳转目标;小幅移动不记', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await gotoLine(win, 300);
  // 小幅移动(< 10 行)只更新当前这条
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line302 = 302;');

  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-activeLine')).toHaveText('const line1 = 1;');
  await expect(win.locator('.cm-content')).toBeFocused();
  await win.keyboard.press(FORWARD);
  await expect(win.locator('.cm-activeLine')).toHaveText('const line302 = 302;');
  // 栈顶再前进:不动
  await win.keyboard.press(FORWARD);
  await expect(win.locator('.cm-activeLine')).toHaveText('const line302 = 302;');
});

test('后退后再打开别的文件 → 前进部分清掉', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await quickOpen(win, 'other.ts');
  await expect(win.locator('.cm-content')).toContainText('export const other = 1;');
  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-content')).toContainText('const line1 = 1;');
  await quickOpen(win, 'third.ts');
  await expect(win.locator('.cm-content')).toContainText('export const third = 3;');
  await win.keyboard.press(FORWARD);
  // 没有前进部分:仍在 third.ts
  await win.waitForTimeout(300);
  await expect(win.locator('.cm-content')).toContainText('export const third = 3;');
  // 后退依次回到 big.ts,再往前没有了(other.ts 已不在栈上 —— 被新导航截掉)
  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-content')).toContainText('const line1 = 1;');
  await win.keyboard.press(BACK);
  await win.waitForTimeout(300);
  await expect(win.locator('.cm-content')).toContainText('const line1 = 1;');
});
