// ⌘P 输入 `文件名:行号`(VSCode Quick Open 同):剥掉行号匹配文件,打开后光标在该行;后退一次回到来处。
// BDD: src/__tests__/quick-open-file-line/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { QUICK_OPEN_SEARCH } from './helpers/palette';

const isMac = process.platform === 'darwin';
const BACK = isMac ? 'Control+Minus' : 'Alt+ArrowLeft';
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
  writeFileSync(path.join(ws, 'a.ts'), 'const a = 1;\n');
  writeFileSync(path.join(ws, 'long.ts'), Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'));
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await openTreeItem(win, /^a\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('const a = 1;', { timeout: 10_000 });
  await win.locator('.cm-content').click();
  return win;
}

test('`long.ts:200` 列出 long.ts,回车打开并跳到第 200 行(在视野内),焦点在编辑器;后退一次回到 a.ts', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+p');
  const input = win.getByRole('combobox', { name: QUICK_OPEN_SEARCH });
  await expect(input).toBeVisible();
  await win.keyboard.type('long.ts:200');
  await expect(win.getByRole('option')).toHaveCount(1);
  await expect(win.getByRole('option').first()).toContainText('long.ts');
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
  const active = win.locator('.cm-activeLine');
  await expect(active).toHaveText('const line200 = 200;', { timeout: 10_000 });
  await expect(active).toBeInViewport();
  await expect(win.locator('.cm-content')).toBeFocused();
  await win.keyboard.press(BACK);
  await expect(win.locator('.cm-content')).toContainText('const a = 1;');
  await expect(win.locator('.cm-content')).not.toContainText('const line200');
});

test('`long.ts(120,7)`:跳到第 120 行第 7 列', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+p');
  await win.keyboard.type('long.ts(120,7)');
  await expect(win.getByRole('option')).toHaveCount(1);
  await win.keyboard.press('Enter');
  await expect(win.locator('.cm-activeLine')).toHaveText('const line120 = 120;', { timeout: 10_000 });
  await win.keyboard.type('X');
  await expect(win.locator('.cm-activeLine')).toHaveText('const Xline120 = 120;');
});

test('行号越界 `long.ts:9999`(共 400 行)→ 夹到最后一行(VSCode 同;同 ⌃G 转到行)', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+p');
  await win.keyboard.type('long.ts:9999');
  await expect(win.getByRole('option')).toHaveCount(1);
  await win.keyboard.press('Enter');
  const active = win.locator('.cm-activeLine');
  await expect(active).toHaveText('const line400 = 400;', { timeout: 10_000 });
  await expect(active).toBeInViewport();
  await expect(win.locator('.cm-content')).toBeFocused();
});
