// 转到行 / 列(VSCode workbench.action.gotoLine):⌃G 打开 Quick Open 预填 `:`,键入行号回车跳过去(不写进正文);Esc 回到原位;
// ⌘P 里键入 `:N:C` 同样跳转。BDD: src/__tests__/editor-goto-line/
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

const LINES = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`);

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui98a-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui98a-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'big.ts'), LINES.join('\n'));
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

test('⌃G → 输入 300 回车:光标落到第 300 行,行号不写进正文,焦点回到编辑器', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('Control+g');
  const input = win.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();
  await expect(input).toHaveValue(':');
  await win.keyboard.type('300');
  await expect(input).toHaveValue(':300');
  // 实时预览:输入时编辑器已移到该行
  await expect(win.locator('.cm-activeLine')).toHaveText('const line300 = 300;');
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(win.locator('.cm-activeLine')).toHaveText('const line300 = 300;');
  await expect(win.locator('.cm-content')).toBeFocused();
  // 第一行没有被插入 300
  await win.keyboard.press('ControlOrMeta+Home');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line1 = 1;');
});

test('⌃G 预览后 Esc:光标回到打开前的位置', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('Control+g');
  await win.keyboard.type('200');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line200 = 200;');
  await win.keyboard.press('Escape');
  await expect(win.getByRole('combobox', { name: QUICK_OPEN_SEARCH })).toBeHidden();
  await expect(win.locator('.cm-activeLine')).toHaveText('const line1 = 1;');
});

test('⌘P 里键入 `:50:7` 回车 → 第 50 行第 7 列;越界行号夹到最后一行', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+p');
  const input = win.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();
  await win.keyboard.type(':50:7');
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect(win.locator('.cm-activeLine')).toHaveText('const line50 = 50;');
  // 第 7 列:光标前是「const 」
  await win.keyboard.type('X');
  await expect(win.locator('.cm-activeLine')).toHaveText('const Xline50 = 50;');

  await win.keyboard.press('Control+g');
  await win.keyboard.type('99999');
  await win.keyboard.press('Enter');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line400 = 400;');
});
