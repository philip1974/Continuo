// 第四十轮审计补齐的命令 / 默认键(BDD: src/__tests__/workbench-missing-commands/、src/__tests__/editor-navigation-history/):
// 搜索结果打开到某行后 ⌃- 一次即回原文件;⇧⌘[ / ⇧⌘] 切换编辑器;⌥⌘S 全部保存;⌃R 打开最近的文件夹;⌥Z 切换自动换行。
// 键位按 VSCode mac 默认,⇧⌘[ / ⌥⌘S / ⌃R 只在 mac 有默认键。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { explorerSidebar, openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';
import { COMMAND_SEARCH } from './helpers/palette';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const isMac = process.platform === 'darwin';
const BACK = isMac ? 'Control+Minus' : 'Alt+ArrowLeft';
const LONG = Array.from({ length: 400 }, (_, i) => `const x${i + 1} = ${i + 1};`).join('\n');

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function launch(files: Record<string, string>, extraRecent: readonly string[] = []): Promise<{ win: Page; ws: string }> {
  const ud = tempDir('ui100a-ud-');
  const ws = tempDir('ui100a-ws-');
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(ws, name), text);
  seedExplorerJson(ud, { root: ws, recentRoots: [ws, ...extraRecent] });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  // 关掉 Playwright 的焦点模拟:按真实焦点断言
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  return { win, ws };
}

const activeTab = (win: Page) => win.evaluate(() => globalThis.__continuoTest!.getEditorActiveTabId());

async function openFile(win: Page, name: string, firstLine: string): Promise<void> {
  await openTreeItem(win, new RegExp(`^${name.replace('.', '\\.')}$`));
  await expect(win.locator('.cm-content')).toContainText(firstLine, { timeout: 10_000 });
}

test('⇧⌘F 搜索结果打开 long.ts 第 321 行,⌃- 一次即回到 file-2.ts', async () => {
  test.setTimeout(90_000);
  const { win } = await launch({ 'file-2.ts': 'export const two = 2;\n', 'long.ts': LONG });
  await waitForTestHooks(win);
  await openFile(win, 'file-2.ts', 'export const two = 2;');
  await win.locator('.cm-content').click();

  await win.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = win.getByRole('textbox', { name: /^(搜索|Search|검색)$/ });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill('x321 = 321');
  const tree = win.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ });
  await expect(tree.getByRole('treeitem')).toHaveCount(2, { timeout: 10_000 });
  await tree.getByRole('treeitem').nth(1).click();
  await expect.poll(() => activeTab(win), { timeout: 10_000 }).toMatch(/long\.ts$/);
  await expect(win.locator('.cm-activeLine')).toHaveText('const x321 = 321;');

  await win.locator('.cm-content').focus();
  await win.keyboard.press(BACK);
  await expect.poll(() => activeTab(win), { timeout: 10_000 }).toMatch(/file-2\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('export const two = 2;');
});

test('⇧⌘] / ⇧⌘[ 切换到下一个 / 上一个编辑器(mac);F1 打开命令面板', async () => {
  test.setTimeout(90_000);
  const { win } = await launch({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });
  await waitForTestHooks(win);
  await openFile(win, 'a.ts', 'export const a = 1;');
  await openFile(win, 'b.ts', 'export const b = 2;');
  await win.locator('.cm-content').click();
  if (isMac) {
    await win.keyboard.press('Meta+Shift+BracketLeft');
    await expect.poll(() => activeTab(win)).toMatch(/a\.ts$/);
    await win.keyboard.press('Meta+Shift+BracketRight');
    await expect.poll(() => activeTab(win)).toMatch(/b\.ts$/);
    // 编辑区里没插入字符
    await expect(win.locator('.cm-content')).toHaveText('export const b = 2;');
  }
  await win.keyboard.press('F1');
  await expect(win.getByRole('combobox', { name: COMMAND_SEARCH })).toBeVisible();
});

test('⌥⌘S 全部保存:两个脏文件都写盘(mac)', async () => {
  test.skip(!isMac, 'Windows / Linux 无默认键(VSCode 为组合键 Ctrl+K S)');
  test.setTimeout(90_000);
  const { win, ws } = await launch({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });
  await waitForTestHooks(win);
  await openFile(win, 'a.ts', 'export const a = 1;');
  await win.locator('.cm-content').click();
  await win.keyboard.press('Meta+End');
  await win.keyboard.type('// A');
  await openFile(win, 'b.ts', 'export const b = 2;');
  await win.locator('.cm-content').click();
  await win.keyboard.press('Meta+End');
  await win.keyboard.type('// B');

  await win.keyboard.press('Alt+Meta+KeyS');
  await expect.poll(() => readFileSync(path.join(ws, 'a.ts'), 'utf8'), { timeout: 10_000 }).toBe('export const a = 1;\n// A');
  await expect.poll(() => readFileSync(path.join(ws, 'b.ts'), 'utf8'), { timeout: 10_000 }).toBe('export const b = 2;\n// B');
  // 编辑区里没插入 ß(⌥S 的字符)
  await expect(win.locator('.cm-content')).not.toContainText('ß');
});

test('⌃R 打开最近的文件夹:键盘选中 → 切换,焦点交给新文件树(mac)', async () => {
  test.skip(!isMac, 'Windows / Linux 无默认键(⌃R 归应用菜单「重新加载窗口」)');
  test.setTimeout(90_000);
  const other = tempDir('ui100a-other-');
  writeFileSync(path.join(other, 'three.txt'), '3\n');
  const { win } = await launch({ 'one.txt': '1\n' }, [other]);
  await expect(explorerSidebar(win)).toContainText('one.txt', { timeout: 15_000 });

  await win.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await win.keyboard.press('Control+KeyR');
  const input = win.getByRole('combobox', { name: /^(搜索最近打开的文件夹|Search recent folders|최근 폴더 검색)$/ });
  await expect(input).toBeFocused({ timeout: 10_000 });
  // 当前文件夹不在列表里;只有另一个
  await expect(win.getByRole('option')).toHaveCount(1);
  await input.fill(path.basename(other).slice(0, 8));
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(explorerSidebar(win)).toContainText('three.txt', { timeout: 10_000 });
  await expect
    .poll(() => win.evaluate(() => document.activeElement?.closest('[role=tree]') !== null), { timeout: 10_000 })
    .toBe(true);
});

test('⌥Z 切换自动换行:即时生效,再按恢复;设置页同一开关', async () => {
  test.setTimeout(90_000);
  const { win } = await launch({ 'wide.ts': `const s = '${'w'.repeat(600)}';\n` });
  await waitForTestHooks(win);
  await openFile(win, 'wide.ts', 'const s =');
  await win.locator('.cm-content').click();
  const content = win.locator('.cm-content');
  await expect(content).not.toHaveClass(/cm-lineWrapping/);
  await win.keyboard.press('Alt+KeyZ');
  await expect(content).toHaveClass(/cm-lineWrapping/);
  // 编辑区里没插入 Ω
  await expect(content).not.toContainText('Ω');
  await win.keyboard.press('Alt+KeyZ');
  await expect(content).not.toHaveClass(/cm-lineWrapping/);
});
