// 折叠(VSCode editor.fold ⌥⌘[ / Ctrl+Shift+[):折叠包住光标的最内层可折叠区域(光标不必在区域首行);展开 ⌥⌘] 在折叠占位所在行展开。
// BDD: src/__tests__/editor-text-commands/(第 5 条)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const isMac = process.platform === 'darwin';
const FOLD = isMac ? 'Meta+Alt+BracketLeft' : 'Control+Shift+BracketLeft';
const UNFOLD = isMac ? 'Meta+Alt+BracketRight' : 'Control+Shift+BracketRight';
const SRC = ['function a() {', '  if (x) {', '    foo();', '  }', '  bar();', '}', 'const z = 1;'].join('\n');

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui102b-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui102b-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), SRC);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await openTreeItem(win, /^a\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('const z = 1;', { timeout: 10_000 });
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Home');
  return win;
}

const lines = (win: Page): Promise<string[]> => win.locator('.cm-content .cm-line').allTextContents();

test('光标在 if 块内一行 → 折叠 if;再折叠 → 外层函数;⌥⌘] 在占位行展开', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('ArrowDown'); // 光标到 `    foo();`(不是区域首行)
  await win.keyboard.press(FOLD);
  await expect(win.locator('.cm-foldPlaceholder')).toHaveCount(1);
  await expect.poll(() => lines(win)).toEqual(['function a() {', '  if (x) {…}', '  bar();', '}', 'const z = 1;']);
  await win.keyboard.press(FOLD);
  await expect.poll(() => lines(win)).toEqual(['function a() {…}', 'const z = 1;']);
  await win.keyboard.press(UNFOLD);
  await expect.poll(() => lines(win)).toEqual(['function a() {', '  if (x) {…}', '  bar();', '}', 'const z = 1;']);
});
