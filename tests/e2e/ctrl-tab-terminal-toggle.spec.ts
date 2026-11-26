// ⌃Tab 按组内最近使用顺序切换编辑器(按住 ⌃ 连按依次往后,不来回跳)、终端里 ⌃Tab 同样切编辑器;⌃` 在编辑器与终端之间往返
//(没有终端时新建)。BDD: src/__tests__/editor-recent-cycle/、src/__tests__/terminal-toggle/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITOR_TABS, TERMINAL_PANEL_TAB } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NAMES = ['a', 'b', 'c', 'd'] as const;

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui98a-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui98a-ws-'));
  dirs.push(ud, ws);
  for (const n of NAMES) writeFileSync(path.join(ws, `${n}.ts`), `export const ${n} = '${n}';\n`);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 关掉 Playwright 的焦点模拟:按真实焦点断言
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return win;
}

const activeEditorTab = (win: Page): Promise<string> =>
  win
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab', { selected: true })
    .evaluate((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop() ?? '');
const focusIn = (win: Page): Promise<'terminal' | 'editor' | 'other'> =>
  win.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest('.xterm')) return 'terminal';
    if (el?.closest('.cm-editor')) return 'editor';
    return 'other';
  });

async function openAll(win: Page): Promise<void> {
  for (const n of NAMES) {
    await openTreeItem(win, new RegExp(`^${n}\\.ts$`));
    await expect(win.locator('.cm-content')).toContainText(`export const ${n}`, { timeout: 10_000 });
  }
}

test('⌃Tab:按住 ⌃ 连按沿 MRU 往后(d → c → b),松开后再按回到上一个(d);⌃⇧Tab 落到最久未用的', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await openAll(win);
  await win.locator('.cm-content').click();
  expect(await activeEditorTab(win)).toBe('d.ts');

  await win.keyboard.down('Control');
  await win.keyboard.press('Tab');
  await expect.poll(() => activeEditorTab(win)).toBe('c.ts');
  await win.keyboard.press('Tab');
  await expect.poll(() => activeEditorTab(win)).toBe('b.ts');
  await win.keyboard.up('Control');

  await win.keyboard.press('Control+Tab');
  await expect.poll(() => activeEditorTab(win)).toBe('d.ts');
  await expect.poll(() => focusIn(win)).toBe('editor');

  await win.keyboard.press('Control+Shift+Tab');
  await expect.poll(() => activeEditorTab(win)).toBe('a.ts');
  // 正文没有被插入 Tab
  await expect(win.locator('.cm-content')).toHaveText("export const a = 'a';");
});

test('⌃` 往返:编辑器 → 新建终端(获焦)→ 回到编辑器 → 回到同一个终端;终端里 ⌃Tab 切编辑器', async () => {
  test.setTimeout(120_000);
  const win = await launch();
  await openAll(win);
  await win.locator('.cm-content').click();
  await expect.poll(() => focusIn(win)).toBe('editor');

  await win.keyboard.press('Control+Backquote');
  const terminalTabs = win.getByRole('tab', { name: TERMINAL_PANEL_TAB });
  await expect(terminalTabs).toHaveCount(1, { timeout: 20_000 });
  await expect.poll(() => focusIn(win), { timeout: 15_000 }).toBe('terminal');

  await win.keyboard.press('Control+Backquote');
  await expect.poll(() => focusIn(win)).toBe('editor');
  expect(await activeEditorTab(win)).toBe('d.ts');

  await win.keyboard.press('Control+Backquote');
  await expect.poll(() => focusIn(win)).toBe('terminal');
  await expect(terminalTabs).toHaveCount(1);

  // 焦点在终端:⌃Tab 让出,切到上一个最近使用的编辑器
  await win.keyboard.press('Control+Tab');
  await expect.poll(() => activeEditorTab(win)).toBe('c.ts');
  await expect(win.locator('.cm-content')).toBeVisible();
  await expect.poll(() => focusIn(win)).toBe('editor');
  // 按键没有进 shell 也没有写进正文
  await expect(win.locator('.cm-content')).toHaveText("export const c = 'c';");
});
