// 编辑器 tab / 组管理(对齐 VSCode):⌃⌘→ 移到下一组保持光标与脏内容、固定 tab 后「关闭其他」保留且重启后仍固定、⌥⌘→ 跨组、
// 关组后焦点到最近使用的组、⌃1 / ⌃9 按序号直达、关闭含脏文件的组弹确认(取消 / 不保存 / 保存)、设置页挡住编辑器组时 tab 级键不动藏在后面的文件。
// BDD: src/__tests__/editor-tab-management/、src/__tests__/editor-groups/(close-dirty)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  EDITOR_CANCEL,
  EDITOR_DONT_SAVE,
  EDITOR_SAVE,
  EDITOR_SAVE_CHANGES_TITLE,
  EDITOR_TABS,
} from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { openSettings, SETTINGS_NAV } from './helpers/settings';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const groups = (win: Page): Locator => win.locator('[data-editor-panel-root]');
const group = (win: Page, i: number): Locator => groups(win).nth(i);
const tabList = (g: Locator): Locator => g.getByRole('tablist', { name: EDITOR_TABS });
const tabTitles = (g: Locator): Promise<string[]> =>
  tabList(g)
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop() ?? ''));
const activeTitle = (g: Locator): Promise<string> =>
  tabList(g)
    .getByRole('tab', { selected: true })
    .evaluate((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop() ?? '');

/** 焦点所在的编辑器组(按 DOM 顺序的下标;不在任何组里 → -1)。 */
const focusedGroupIndex = (win: Page): Promise<number> =>
  win.evaluate(() => {
    const roots = [...document.querySelectorAll('[data-editor-panel-root]')];
    const root = document.activeElement?.closest('[data-editor-panel-root]');
    return root ? roots.indexOf(root) : -1;
  });

async function launch(ud: string): Promise<Page> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 测焦点:关掉 Playwright 的焦点模拟,按真实焦点判定(同 keybindings-context-menu 等)
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return win;
}

/** 临时 user-data-dir + 工作区(a.ts / b.ts / c.ts);返回 [user-data-dir, 工作区]。 */
function workspace(): [string, string] {
  const ud = mkdtempSync('/private/tmp/claude-501/ui179-ud-');
  const ws = mkdtempSync('/private/tmp/claude-501/ui179-ws-');
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(ws, 'b.ts'), 'export const b = 2;\n');
  writeFileSync(path.join(ws, 'c.ts'), 'export const c = 3;\n');
  seedExplorerJson(ud, { root: ws });
  return [ud, ws];
}

async function openFiles(win: Page, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await openTreeItem(win, new RegExp(`^${name.replace('.', '\\.')}$`));
    await expect.poll(() => activeTitle(group(win, 0))).toBe(name);
  }
}

/** 在活动组的代码编辑器里点一下(获焦)。 */
async function focusEditor(g: Locator): Promise<Locator> {
  const cm = g.locator('.cm-content');
  await cm.click();
  await expect(cm).toBeFocused();
  return cm;
}

// 各平台默认键(同 VSCode):mac ⌃⌘→ / ⌥⌘→ / ⌃1 / ⌘9;Windows / Linux Ctrl+Alt+→ / Ctrl+PageDown / Alt+1 / Alt+0
const isMac = process.platform === 'darwin';
const K = {
  mod: isMac ? 'Meta' : 'Control',
  moveNext: isMac ? 'Control+Meta+ArrowRight' : 'Control+Alt+ArrowRight',
  movePrev: isMac ? 'Control+Meta+ArrowLeft' : 'Control+Alt+ArrowLeft',
  nextEditor: isMac ? 'Alt+Meta+ArrowRight' : 'Control+PageDown',
  prevEditor: isMac ? 'Alt+Meta+ArrowLeft' : 'Control+PageUp',
  atIndex: (n: number) => `${isMac ? 'Control' : 'Alt'}+${n}`,
  last: isMac ? 'Meta+9' : 'Alt+0',
  lastAlt: isMac ? 'Control+0' : 'Alt+0',
};

test('⌃⌘→:没有下一组时向右新建组并移过去,光标、脏内容、焦点跟随', async () => {
  test.setTimeout(90_000);
  const [ud] = workspace();
  const win = await launch(ud);
  await openFiles(win, ['a.ts', 'b.ts']);
  const cm = await focusEditor(group(win, 0));
  await win.keyboard.press(`${K.mod}+End`);
  await win.keyboard.type('XYZ');
  await win.keyboard.press('ArrowLeft');
  await win.keyboard.press('ArrowLeft');
  await expect(cm).toContainText('XYZ');
  await win.keyboard.press(K.moveNext);
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  expect(await tabTitles(group(win, 0))).toEqual(['a.ts']);
  expect(await tabTitles(group(win, 1))).toEqual(['b.ts']);
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
  // 光标仍在 X 之后
  await win.keyboard.type('!');
  await expect(group(win, 1).locator('.cm-content')).toContainText('X!YZ');
  await expect(tabList(group(win, 1)).getByRole('tab').first()).toHaveAttribute('data-dirty', 'true');
  // ⌃⌘← 移回第一组(源组随之关闭)
  await win.keyboard.press(K.movePrev);
  await expect(groups(win)).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => tabTitles(group(win, 0))).toEqual(['a.ts', 'b.ts']);
  await expect(group(win, 0).locator('.cm-content')).toContainText('X!YZ');
});

test('固定 tab:移到最左、图钉代替 ×;「关闭其他」保留它;重启后仍固定', async () => {
  test.setTimeout(90_000);
  const [ud] = workspace();
  const win1 = await launch(ud);
  await openFiles(win1, ['a.ts', 'b.ts', 'c.ts']);
  const g = group(win1, 0);
  await tabList(g).getByRole('tab').nth(1).click({ button: 'right' });
  await win1.getByRole('menuitem', { name: /^(固定|Pin|고정)$/ }).click();
  await expect.poll(() => tabTitles(g)).toEqual(['b.ts', 'a.ts', 'c.ts']);
  const pinned = tabList(g).getByRole('tab').first();
  await expect(pinned).toHaveAttribute('data-pinned', 'true');
  await expect(pinned.locator('.wm-tab-nav-item__close')).toHaveCount(0);
  // 在 c.ts 上「关闭其他」:a.ts 关闭,固定的 b.ts 保留
  await tabList(g).getByRole('tab').nth(2).click({ button: 'right' });
  await win1.getByRole('menuitem', { name: /^(关闭其他|Close Others|기타 항목 닫기)/ }).click();
  await expect.poll(() => tabTitles(g)).toEqual(['b.ts', 'c.ts']);
  await closeDiscardingUnsaved(apps.pop()!);

  const win2 = await launch(ud);
  await expect.poll(() => tabTitles(group(win2, 0)), { timeout: 15_000 }).toEqual(['b.ts', 'c.ts']);
  await expect(tabList(group(win2, 0)).getByRole('tab').first()).toHaveAttribute('data-pinned', 'true');
  // 点图钉取消固定
  await tabList(group(win2, 0)).getByRole('tab').first().locator('.wm-tab-nav-item__pin').click();
  await expect(tabList(group(win2, 0)).getByRole('tab').first()).not.toHaveAttribute('data-pinned', 'true');
});

test('⌥⌘→ 跨组:到组尾跳到下一组的第一个,最后一组的尾回到第一组', async () => {
  test.setTimeout(90_000);
  const [ud] = workspace();
  const win = await launch(ud);
  await openFiles(win, ['a.ts']);
  await focusEditor(group(win, 0));
  await win.keyboard.press(`${K.mod}+Backslash`);
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  await openTreeItem(win, /^b\.ts$/);
  await expect.poll(() => tabTitles(group(win, 1))).toEqual(['a.ts', 'b.ts']);
  await win.keyboard.press(`${K.mod}+1`);
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.press(K.nextEditor);
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
  await expect.poll(() => activeTitle(group(win, 1))).toBe('a.ts');
  await win.keyboard.press(K.nextEditor);
  await expect.poll(() => activeTitle(group(win, 1))).toBe('b.ts');
  await win.keyboard.press(K.nextEditor);
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.press(K.prevEditor);
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
  await expect.poll(() => activeTitle(group(win, 1))).toBe('b.ts');
});

test('关掉活动组后焦点落到最近使用的组(不是左邻)', async () => {
  test.setTimeout(90_000);
  const [ud] = workspace();
  const win = await launch(ud);
  await openFiles(win, ['a.ts']);
  await focusEditor(group(win, 0));
  await win.keyboard.press(`${K.mod}+Backslash`);
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  await win.keyboard.press(`${K.mod}+Backslash`);
  await expect(groups(win)).toHaveCount(3, { timeout: 10_000 });
  // 最近使用:第 2 组 → 第 3 组 → 第 1 组
  await win.keyboard.press(`${K.mod}+1`);
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.press(`${K.mod}+3`);
  await expect.poll(() => focusedGroupIndex(win)).toBe(2);
  await win.keyboard.press(`${K.mod}+2`);
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
  // ⌘W 关掉第 2 组唯一的编辑器 → 组关闭,焦点到第 3 组(DOM 下标 1)
  await win.keyboard.press(`${K.mod}+w`);
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
});

test('⌃1 / ⌃3 按序号直达,⌃9 不存在第 9 个 → 不动,⌘9 / ⌃0 最后一个(Win/Linux Alt+数字 / Alt+0)', async () => {
  test.setTimeout(90_000);
  const [ud] = workspace();
  const win = await launch(ud);
  await openFiles(win, ['a.ts', 'b.ts', 'c.ts']);
  await focusEditor(group(win, 0));
  await win.keyboard.press(K.atIndex(1));
  await expect.poll(() => activeTitle(group(win, 0))).toBe('a.ts');
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.press(K.atIndex(3));
  await expect.poll(() => activeTitle(group(win, 0))).toBe('c.ts');
  await win.keyboard.press(K.atIndex(1));
  await win.keyboard.press(K.atIndex(9));
  await expect.poll(() => activeTitle(group(win, 0))).toBe('a.ts');
  await win.keyboard.press(K.last);
  await expect.poll(() => activeTitle(group(win, 0))).toBe('c.ts');
  await win.keyboard.press(K.atIndex(1));
  await win.keyboard.press(K.lastAlt);
  await expect.poll(() => activeTitle(group(win, 0))).toBe('c.ts');
});

test('设置页挡在编辑器组前面:⌃⌘→ / ⌃⌘← / ⌃1 / ⌥⌘→ 不动藏在后面的文件,设置页仍在前面', async () => {
  test.setTimeout(90_000);
  const [ud] = workspace();
  const win = await launch(ud);
  await openFiles(win, ['a.ts', 'b.ts', 'c.ts']);
  await focusEditor(group(win, 0));
  await openSettings(win);
  const nav = win.getByRole('navigation', { name: SETTINGS_NAV });
  await expect(groups(win)).toHaveCount(0); // 编辑器组被设置页挡住(同一 dock 组里不渲染)
  for (const key of [K.moveNext, K.movePrev, K.atIndex(1), K.nextEditor, K.last]) await win.keyboard.press(key);
  await expect(nav).toBeVisible();
  // ⌘W 照旧关闭设置页本身(行为不变),编辑器组回到前面:组数、tab 顺序与活动 tab 都没变
  await win.keyboard.press(`${K.mod}+w`);
  await expect(nav).toHaveCount(0);
  await expect(groups(win)).toHaveCount(1);
  expect(await tabTitles(group(win, 0))).toEqual(['a.ts', 'b.ts', 'c.ts']);
  expect(await activeTitle(group(win, 0))).toBe('c.ts');
});

test('dock tab × 关闭含脏文件的组:取消 → 组不关;不保存 → 组关闭、文件不写盘;保存 → 写盘后组关闭', async () => {
  test.setTimeout(120_000);
  const [ud, ws] = workspace();
  const win = await launch(ud);
  await openFiles(win, ['a.ts']);
  await focusEditor(group(win, 0));
  const closeSecondGroup = async () => {
    const dockTab = win.locator('.dv-tab').filter({ hasText: / 2$/ });
    await dockTab.hover();
    await dockTab.getByRole('button', { name: /^(关闭 |Close |.+ 닫기$)/ }).click();
  };
  const makeDirtySecondGroup = async (file: string, text: string) => {
    await win.keyboard.press(`${K.mod}+Backslash`);
    await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
    await openTreeItem(win, new RegExp(`^${file.replace('.', '\\.')}$`));
    await expect.poll(() => activeTitle(group(win, 1))).toBe(file);
    // 关掉第二组里的 a.ts(仍在第一组打开),只留只在本组的 file
    await tabList(group(win, 1)).getByRole('tab').first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^(关闭|Close|닫기)$/ }).click();
    await expect.poll(() => tabTitles(group(win, 1))).toEqual([file]);
    const cm = await focusEditor(group(win, 1));
    await win.keyboard.press(`${K.mod}+End`);
    await win.keyboard.type(text);
    await expect(cm).toContainText(text);
  };

  // 取消
  await makeDirtySecondGroup('b.ts', '// unsaved-b');
  await closeSecondGroup();
  await expect(win.getByRole('dialog').getByText(EDITOR_SAVE_CHANGES_TITLE)).toBeVisible();
  await win.getByRole('dialog').getByRole('button', { name: EDITOR_CANCEL }).click();
  await expect(win.getByRole('dialog')).toHaveCount(0);
  await expect(groups(win)).toHaveCount(2);
  await expect(group(win, 1).locator('.cm-content')).toContainText('// unsaved-b');

  // 不保存
  await closeSecondGroup();
  await win.getByRole('dialog').getByRole('button', { name: EDITOR_DONT_SAVE }).click();
  await expect(groups(win)).toHaveCount(1, { timeout: 10_000 });
  expect(await tabTitles(group(win, 0))).toEqual(['a.ts']);
  expect(readFileSync(path.join(ws, 'b.ts'), 'utf8')).toBe('export const b = 2;\n');

  // 保存
  await focusEditor(group(win, 0));
  await makeDirtySecondGroup('c.ts', '// saved-c');
  await closeSecondGroup();
  await win.getByRole('dialog').getByRole('button', { name: EDITOR_SAVE }).click();
  await expect(groups(win)).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(() => readFileSync(path.join(ws, 'c.ts'), 'utf8')).toContain('// saved-c');
});
