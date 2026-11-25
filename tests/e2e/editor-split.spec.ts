// 编辑器拆分(多编辑器组,对齐 VSCode editor groups):⌘\ 拆分后两组显示同一文件、一处编辑另一处同步、⌘1 / ⌘2 切组、
// Explorer 打开文件落到活动组、关掉组内最后一个文件关闭该组、重启恢复两组。BDD: src/__tests__/editor-groups/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { EDITOR_MODE_EDIT, EDITOR_TABS, editorModeButton } from './helpers/editor';
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

const groups = (win: Page): Locator => win.locator('[data-editor-panel-root]');
const group = (win: Page, i: number): Locator => groups(win).nth(i);
const tabTitles = (g: Locator): Promise<string[]> =>
  g
    .getByRole('tablist', { name: EDITOR_TABS })
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => (el.getAttribute('title') ?? '').split(/[\\/]/).pop() ?? ''));

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
  return win;
}

/** 临时 user-data-dir + 工作区(a.ts / b.ts);app 关闭后在 afterEach 里删除。返回 user-data-dir。 */
function workspace(): string {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui48s-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui48s-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(ws, 'b.ts'), 'export const b = 2;\n');
  writeFileSync(path.join(ws, 'README.md'), '# Title\n\nbody\n');
  seedExplorerJson(ud, { root: ws });
  return ud;
}

async function openAndSplit(win: Page): Promise<void> {
  await openTreeItem(win, /^a\.ts$/);
  const cm = group(win, 0).locator('.cm-content');
  await expect(cm).toContainText('export const a = 1;', { timeout: 10_000 });
  await cm.click();
  await expect(cm).toBeFocused();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
}

test('⌘\\ 拆分:两组显示同一文件,一处编辑另一处同步;⌘1 / ⌘2 切组;Explorer 打开落到活动组;关空组', async () => {
  test.setTimeout(90_000);
  const win = await launch(workspace());
  await openAndSplit(win);
  // 两组都显示 a.ts,新组(右侧)获焦
  for (const i of [0, 1]) {
    expect(await tabTitles(group(win, i))).toEqual(['a.ts']);
    await expect(group(win, i).locator('.cm-content')).toContainText('export const a = 1;');
  }
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);

  // 在右组输入 → 左组实时同步(共享文档,两边都显示未保存)
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.type('// typed in group 2');
  await expect(group(win, 0).locator('.cm-content')).toContainText('// typed in group 2');

  // ⌘1 / ⌘2 切组
  await win.keyboard.press('ControlOrMeta+1');
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.type('/* g1 */');
  await expect(group(win, 1).locator('.cm-content')).toContainText('/* g1 */');
  await win.keyboard.press('ControlOrMeta+2');
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);

  // Explorer 打开 b.ts → 落到活动组(右组),左组不变
  await openTreeItem(win, /^b\.ts$/);
  await expect.poll(() => tabTitles(group(win, 1))).toEqual(['a.ts', 'b.ts']);
  expect(await tabTitles(group(win, 0))).toEqual(['a.ts']);

  // 关掉右组的两个文件:a.ts 仍在左组打开(脏也不弹确认),b.ts 干净 → 右组随最后一个文件关闭
  await win.keyboard.press('ControlOrMeta+w');
  await expect.poll(() => tabTitles(group(win, 1))).toEqual(['a.ts']);
  await win.keyboard.press('ControlOrMeta+w');
  await expect(win.getByRole('dialog')).toHaveCount(0);
  await expect(groups(win)).toHaveCount(1, { timeout: 10_000 });
  expect(await tabTitles(group(win, 0))).toEqual(['a.ts']);
  await expect(group(win, 0).locator('.cm-content')).toContainText('// typed in group 2');
});

test('重启恢复两个编辑器组(各自的文件与活动组)', async () => {
  test.setTimeout(90_000);
  const ud = workspace();
  const win1 = await launch(ud);
  await openAndSplit(win1);
  await openTreeItem(win1, /^b\.ts$/);
  await expect.poll(() => tabTitles(group(win1, 1))).toEqual(['a.ts', 'b.ts']);
  await closeDiscardingUnsaved(apps.pop()!);

  const win2 = await launch(ud);
  await expect(groups(win2)).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(() => tabTitles(group(win2, 0))).toEqual(['a.ts']);
  await expect.poll(() => tabTitles(group(win2, 1))).toEqual(['a.ts', 'b.ts']);
  await expect(group(win2, 1).locator('.cm-content')).toContainText('export const b = 2;');
  // 活动组 = 右组:标题栏显示它的活动文件
  await expect(win2.locator('header').first()).toContainText('b.ts');
});

test('tab 右键「向下拆分」:新组在下方,显示该文件', async () => {
  const win = await launch(workspace());
  await openTreeItem(win, /^a\.ts$/);
  await expect(group(win, 0).locator('.cm-content')).toContainText('export const a = 1;', { timeout: 10_000 });
  await group(win, 0).getByRole('tab', { name: /a\.ts/ }).click({ button: 'right' });
  await win.getByRole('menuitem', { name: /^(向下拆分|Split Down|아래쪽으로 분할)$/ }).click();
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  expect(await tabTitles(group(win, 1))).toEqual(['a.ts']);
  const [top, bottom] = await Promise.all([group(win, 0).boundingBox(), group(win, 1).boundingBox()]);
  expect(bottom!.y).toBeGreaterThan(top!.y + top!.height / 2);
});

// 同一 Markdown 两组都用富文本「编辑」:另一组的编辑增量套进本组(不重挂载),本组光标保持、撤销只撤本组输入;
// 非活动组的活动 tab 为 unfocused 样式。
test('Markdown 两组都编辑:另一组输入后回到本组,光标仍在原处;非活动组 tab 栏 unfocused', async () => {
  test.setTimeout(90_000);
  const win = await launch(workspace());
  await openTreeItem(win, /^README\.md$/);
  await editorModeButton(win, EDITOR_MODE_EDIT).click();
  const pm = (i: number): Locator => group(win, i).locator('.milkdown .ProseMirror');
  await expect(pm(0).locator('h1')).toContainText('Title', { timeout: 10_000 });
  await pm(0).locator('p').first().click();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(groups(win)).toHaveCount(2, { timeout: 10_000 });
  await expect(pm(1).locator('h1')).toContainText('Title', { timeout: 10_000 });
  const strip = (i: number): Locator => group(win, i).getByRole('tablist', { name: EDITOR_TABS });
  await expect(strip(0)).toHaveAttribute('data-unfocused', 'true');
  await expect(strip(1)).not.toHaveAttribute('data-unfocused', 'true');

  // 组 1:段落末尾输入 A
  await win.keyboard.press('ControlOrMeta+1');
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await expect(strip(1)).toHaveAttribute('data-unfocused', 'true');
  await pm(0).locator('p').first().click();
  await win.keyboard.press('End');
  await win.keyboard.type('A');
  await expect(pm(1).locator('p').first()).toHaveText('bodyA', { timeout: 10_000 });
  // 组 2:标题末尾输入 R
  await win.keyboard.press('ControlOrMeta+2');
  await expect.poll(() => focusedGroupIndex(win)).toBe(1);
  await pm(1).locator('h1').click();
  await win.keyboard.press('End');
  await win.keyboard.type('R');
  await expect(pm(0).locator('h1')).toHaveText('TitleR', { timeout: 10_000 });
  // 回组 1 输入 B:落在 A 之后(不是文档开头)
  await win.keyboard.press('ControlOrMeta+1');
  await expect.poll(() => focusedGroupIndex(win)).toBe(0);
  await win.keyboard.type('B');
  await expect(pm(0).locator('p').first()).toHaveText('bodyAB');
  await expect(pm(0).locator('h1')).toHaveText('TitleR');
  // 组 1 的撤销栈保留:撤销只撤本组输入,另一组的 R 不受影响
  await win.keyboard.press('ControlOrMeta+z');
  await expect(pm(0).locator('p').first()).not.toHaveText('bodyAB');
  await expect(pm(0).locator('h1')).toHaveText('TitleR');
});
