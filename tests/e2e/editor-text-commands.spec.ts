// 常用编辑器命令进命令注册表(VSCode 同名命令):⌘L 选中行、⇧⌘Enter 编辑器内在上方插入行而终端内仍切换缩放、改键后新键生效
// 旧键失效、命令面板执行「切换行注释」。BDD: src/__tests__/editor-text-commands/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { TERMINAL_PANEL_TAB } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { commandPaletteInput, COMMAND_LIST } from './helpers/palette';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DOC = 'one\ntwo\nthree';

async function launch(): Promise<Page> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui100b-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui100b-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), DOC);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 关掉 Playwright 的焦点模拟:按真实焦点断言
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await openTreeItem(win, /^a\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('three', { timeout: 10_000 });
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Home');
  await expect(win.locator('.cm-activeLine')).toHaveText('one');
  return win;
}

const lines = (win: Page): Promise<string[]> =>
  win.locator('.cm-content').first().locator('.cm-line').allTextContents();
const visibleEditors = (win: Page): Promise<number> =>
  win.evaluate(
    () =>
      [...document.querySelectorAll('.cm-editor')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true });
      }).length,
  );
const focusIn = (win: Page): Promise<'terminal' | 'editor' | 'other'> =>
  win.evaluate(() => {
    const el = document.activeElement;
    if (el?.closest('.xterm')) return 'terminal';
    if (el?.closest('.cm-editor')) return 'editor';
    return 'other';
  });

test('⌘L 选中整行(再按向下扩展一行),接着键入替换所选行', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+l');
  await win.keyboard.press('ControlOrMeta+l');
  await win.keyboard.type('X');
  await expect.poll(() => lines(win)).toEqual(['Xthree']);
});

test('⇧⌘Enter:编辑器里在上方插入行;终端里仍切换终端缩放', async () => {
  test.setTimeout(120_000);
  const win = await launch();
  // 先拆分编辑器(两个组),缩放终端所在组时另一组被挡住,可观察
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect.poll(() => visibleEditors(win)).toBe(2);
  await expect.poll(() => focusIn(win)).toBe('editor');
  await win.keyboard.press('ControlOrMeta+Home');
  await win.keyboard.press('ArrowDown'); // 光标到 two
  await win.keyboard.press('ControlOrMeta+Shift+Enter');
  await win.keyboard.type('Z');
  await expect.poll(() => lines(win)).toEqual(['one', 'Z', 'two', 'three']);
  // ⌘Enter:在下方插入行
  await win.keyboard.press('ControlOrMeta+Enter');
  await win.keyboard.type('Y');
  await expect.poll(() => lines(win)).toEqual(['one', 'Z', 'Y', 'two', 'three']);
  expect(await visibleEditors(win)).toBe(2); // 编辑器里没有触发缩放

  // 新建终端并获焦 → ⇧⌘Enter 切换缩放(另一组的编辑器被挡住),再按恢复;正文不变
  await win.keyboard.press('Control+Backquote');
  await expect(win.getByRole('tab', { name: TERMINAL_PANEL_TAB })).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect.poll(() => focusIn(win), { timeout: 15_000 }).toBe('terminal');
  await expect.poll(() => visibleEditors(win)).toBe(1);
  await win.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect.poll(() => visibleEditors(win)).toBe(0);
  await win.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect.poll(() => visibleEditors(win)).toBe(1);
  expect(await lines(win)).toEqual(['one', 'Z', 'Y', 'two', 'three']);
});

test('把「切换行注释」改到 ⇧⌘Y:新键生效,旧键 ⌘/ 不再注释', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+Slash');
  await expect.poll(() => lines(win)).toEqual(['// one', 'two', 'three']);
  await win.keyboard.press('ControlOrMeta+Slash');
  await expect.poll(() => lines(win)).toEqual(['one', 'two', 'three']);

  await win.evaluate(() =>
    globalThis.__continuoTest!.setHotkey('editor.action.commentLine', 'mod+shift+y'),
  );
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Home');
  await win.keyboard.press('ControlOrMeta+Slash');
  await win.keyboard.press('ControlOrMeta+Shift+y');
  await expect.poll(() => lines(win)).toEqual(['// one', 'two', 'three']);
});

test('命令面板执行「切换行注释」:注释当前行,焦点回到编辑器', async () => {
  test.setTimeout(90_000);
  const win = await launch();
  await win.keyboard.press('ControlOrMeta+Shift+p');
  const input = commandPaletteInput(win);
  await expect(input).toBeVisible();
  await input.fill('Toggle Line Comment');
  await expect(
    win.getByRole('listbox', { name: COMMAND_LIST }).getByRole('option').first(),
  ).toContainText(/(切换行注释|Toggle Line Comment|줄 주석 설정\/해제)/);
  await win.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect.poll(() => lines(win)).toEqual(['// one', 'two', 'three']);
  await expect.poll(() => focusIn(win)).toBe('editor');
  // 焦点确在编辑器:接着输入进正文
  await win.keyboard.press('End');
  await win.keyboard.type('!');
  await expect.poll(() => lines(win)).toEqual(['// one!', 'two', 'three']);
});
