// 应用菜单栏补全(BDD: src/__tests__/app-menu-bar/)。E2E 模式下应用菜单为 null,经 main 的 e2e 钩子(__continuoAppMenu,仅
// CONTINUO_E2E=1)读同一份模板、按路径调用菜单项的 click(与真实点击同一路径:sendMenuCommand → 获焦窗口的主窗 renderer)。
// 1. 菜单结构 + accelerator 跟随改键 / 解绑(renderer 推送生效键位,只显示 registerAccelerator: false)
// 2. 帮助 → 键盘快捷方式参考:打开设置的快捷键页,焦点在该页搜索框
// 3. 编辑 → 切换行注释:焦点不在编辑器也作用于活动文本编辑器(同命令面板);popout 子窗获焦 → 作用于子窗的编辑器,主窗不动
// 4. 编辑 → 撤销 / 重做:文件树聚焦 → 撤销 / 重做文件操作;代码编辑器 / Markdown 编辑聚焦 → 编辑器自己的撤销栈(命令产生的修改、
//    重做都生效;popout 子窗同样)
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DOCK_POPOUT } from './helpers/editor';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const KEYBINDINGS_SEARCH = /^(搜索命令名 \/ 分类 \/ 快捷键…|Search commands \/ categories \/ hotkeys…|명령어 \/ 카테고리 \/ 단축키 검색…)$/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page; ws: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui100c-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui100c-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'main-file.ts'), 'let main = 1;\n');
  writeFileSync(path.join(ws, 'child-file.ts'), 'let child = 2;\n');
  writeFileSync(path.join(ws, 'note.md'), '# Title\n\npara one\n');
  mkdirSync(path.join(ws, 'src'));
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win, ws };
}

const snapshot = (app: ElectronApplication): Promise<MenuSnapshotItem[]> =>
  app.evaluate(() => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot());

/** 顶层第 top 个菜单里 id = 命令 id 的菜单项的下标路径(含子菜单)。 */
function pathOf(items: readonly MenuSnapshotItem[], top: number, id: string): number[] {
  const walk = (list: readonly MenuSnapshotItem[], prefix: number[]): number[] | null => {
    for (const [i, m] of list.entries()) {
      if (m.id === id) return [...prefix, i];
      const sub = m.submenu ? walk(m.submenu, [...prefix, i]) : null;
      if (sub) return sub;
    }
    return null;
  };
  const found = walk(items[top]!.submenu ?? [], [top]);
  if (!found) throw new Error(`menu item ${id} not found in top menu ${top}`);
  return found;
}

const itemAt = (items: readonly MenuSnapshotItem[], p: readonly number[]): MenuSnapshotItem => {
  let list = items;
  let item: MenuSnapshotItem | undefined;
  for (const i of p) {
    item = list[i];
    list = item?.submenu ?? [];
  }
  return item!;
};

/** 窗口 id(主窗 / popout 子窗)。 */
const windowId = (app: ElectronApplication, popout: boolean): Promise<number> =>
  app.evaluate(
    ({ BrowserWindow }, popout) =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1') === popout)!.id,
    popout,
  );

async function clickMenu(app: ElectronApplication, top: number, id: string, popout = false): Promise<void> {
  const p = pathOf(await snapshot(app), top, id);
  const winId = await windowId(app, popout);
  const ok = await app.evaluate(
    (_e, { p, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId),
    { p, winId },
  );
  expect(ok).toBe(true);
}

// macOS 顶层:应用 0 / 文件 1 / 编辑 2 / 选择 3 / 显示 4 / 转到 5 / 终端 6 / 窗口 7 / 帮助 8
const EDIT = process.platform === 'darwin' ? 2 : 1;
const HELP = process.platform === 'darwin' ? 8 : 7;
const FILE = process.platform === 'darwin' ? 1 : 0;

test('菜单结构;accelerator 跟随改键 / 解绑,只显示', async () => {
  test.setTimeout(60_000);
  const { app, win } = await launch();
  const top = await snapshot(app);
  expect(top.length).toBe(process.platform === 'darwin' ? 9 : 8);
  expect(top.at(-1)?.role).toBe('help');

  const saveAll = async () => itemAt(await snapshot(app), pathOf(await snapshot(app), FILE, 'workbench.action.files.saveAll'));
  const mod = process.platform === 'darwin' ? 'Command' : 'Ctrl';
  await expect.poll(async () => (await saveAll()).accelerator, { timeout: 15_000 }).toBe(`${mod}+Alt+S`);
  expect((await saveAll()).registerAccelerator).toBe(false);

  await win.evaluate(() => globalThis.__continuoTest!.setHotkey('workbench.action.files.saveAll', 'mod+shift+9'));
  await expect.poll(async () => (await saveAll()).accelerator).toBe(`${mod}+Shift+9`);
  await win.evaluate(() => globalThis.__continuoTest!.setHotkey('workbench.action.files.saveAll', ''));
  await expect.poll(async () => (await saveAll()).accelerator).toBeUndefined();
});

test('帮助 → 键盘快捷方式参考:打开设置的快捷键页,焦点在该页搜索框', async () => {
  test.setTimeout(60_000);
  const { app, win } = await launch();
  await expect(win.getByRole('treeitem', { name: /^main-file\.ts$/ })).toBeVisible({ timeout: 15_000 });
  await clickMenu(app, HELP, 'workbench.action.openGlobalKeybindings');
  const search = win.getByRole('textbox', { name: KEYBINDINGS_SEARCH });
  await expect(search).toBeVisible({ timeout: 10_000 });
  await expect(search).toBeFocused();
});

test('编辑 → 切换行注释:作用于获焦窗口的活动文本编辑器;popout 子窗获焦 → 子窗的编辑器,主窗不动', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launch();
  const editors = (page: Page) => page.locator('[data-editor-panel-root]');

  // 主窗:开 main-file.ts,焦点放到资源管理器(不在编辑器里)→ 菜单仍作用于活动编辑器
  await openTreeItem(win, /^main-file\.ts$/);
  const mainCm = editors(win).first().locator('.cm-content');
  await expect(mainCm).toContainText('let main = 1;', { timeout: 10_000 });
  await win.getByRole('treeitem', { name: /^src$/ }).click();
  await clickMenu(app, EDIT, 'editor.action.commentLine');
  await expect(mainCm).toContainText('// let main = 1;');

  // ⌘\ 拆出第二组开 child-file.ts,弹出到子窗
  await mainCm.click();
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(editors(win)).toHaveCount(2, { timeout: 10_000 });
  await openTreeItem(win, /^child-file\.ts$/);
  await expect(editors(win).nth(1).locator('.cm-content')).toContainText('let child = 2;', { timeout: 10_000 });
  await editors(win).nth(1).locator('xpath=ancestor::*[contains(@class,"dv-groupview")]').getByRole('button', { name: DOCK_POPOUT }).click();
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThan(1);
  const child = app.windows().find((w) => w !== win)!;
  await child.waitForLoadState('domcontentloaded');
  const childCm = editors(child).locator('.cm-content');
  await expect(childCm).toContainText('let child = 2;', { timeout: 10_000 });

  // 关掉焦点模拟,真正切到子窗(主窗活动编辑器仍是 main-file.ts)
  for (const page of [win, child]) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('popout=1'))?.focus();
  });
  await expect.poll(() => child.evaluate(() => document.hasFocus())).toBe(true);

  await clickMenu(app, EDIT, 'editor.action.commentLine', true);
  await expect(childCm).toContainText('// let child = 2;');
  await expect(mainCm).toContainText('// let main = 1;');
  await expect(mainCm).not.toContainText('// // let main');

  // 子窗编辑器聚焦 → 菜单撤销 / 重做作用于子窗编辑器自己的撤销栈,主窗不动
  await childCm.click();
  await clickMenu(app, EDIT, 'undo', true);
  await expect(childCm.locator('.cm-line').first()).toHaveText('let child = 2;', { timeout: 5_000 });
  await clickMenu(app, EDIT, 'redo', true);
  await expect(childCm).toContainText('// let child = 2;', { timeout: 5_000 });
  await expect(mainCm).toContainText('// let main = 1;');
});

test('编辑 → 撤销 / 重做:Markdown 编辑模式里撤销输入后可重做', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await openTreeItem(win, /^note\.md$/);
  await win.locator('main').getByRole('radio', { name: /^(编辑|Edit|편집)$/ }).first().click();
  const para = win.locator('[data-editor-panel-root] .ProseMirror p').first();
  await expect(para).toHaveText('para one', { timeout: 10_000 });
  await para.click();
  await win.keyboard.press('End');
  await win.keyboard.type(' abc');
  await expect(para).toHaveText('para one abc');
  await clickMenu(app, EDIT, 'undo');
  await expect(para).toHaveText('para one', { timeout: 5_000 });
  await clickMenu(app, EDIT, 'redo');
  await expect(para).toHaveText('para one abc', { timeout: 5_000 });
});

test('编辑 → 撤销 / 重做:文件树聚焦时撤销 / 重做文件操作;代码编辑器里照旧撤销输入', async () => {
  test.setTimeout(90_000);
  const { app, win, ws } = await launch();
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const exists = (p: string) => existsSync(p);

  // 代码编辑器:打开后还没打字,只做命令修改(切换行注释)→ 菜单撤销撤掉它(Chromium 原生撤销栈里没有命令修改);
  // 再输入 → 菜单撤销撤掉输入 → 菜单重做找回(都走 CodeMirror 自己的撤销栈)
  await openTreeItem(win, /^main-file\.ts$/);
  const cm = win.locator('[data-editor-panel-root] .cm-content').first();
  await expect(cm).toContainText('let main = 1;', { timeout: 10_000 });
  await cm.click();
  await win.keyboard.press('ControlOrMeta+Home');
  await clickMenu(app, EDIT, 'editor.action.commentLine');
  await expect(cm).toContainText('// let main = 1;');
  await clickMenu(app, EDIT, 'undo');
  await expect(cm.locator('.cm-line').first()).toHaveText('let main = 1;', { timeout: 5_000 });
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.type('zzz');
  await expect(cm).toContainText('zzz');
  await clickMenu(app, EDIT, 'undo');
  await expect(cm).not.toContainText('zzz', { timeout: 5_000 });
  await clickMenu(app, EDIT, 'redo');
  await expect(cm).toContainText('zzz', { timeout: 5_000 });

  // 文件树:改名后焦点在树里,点菜单撤销 → 改名撤销,重做 → 再改回
  const child = win.getByRole('treeitem', { name: /^child-file\.ts$/ });
  await child.click();
  await child.press('F2');
  const input = win.locator('[role=treeitem] input');
  await expect(input).toBeFocused({ timeout: 5_000 });
  await input.fill('renamed-child.ts');
  await input.press('Enter');
  const renamed = path.join(ws, 'renamed-child.ts');
  await expect.poll(() => exists(renamed)).toBe(true);
  await win.getByRole('treeitem', { name: /^renamed-child\.ts$/ }).click();
  await clickMenu(app, EDIT, 'undo');
  await expect.poll(() => exists(path.join(ws, 'child-file.ts'))).toBe(true);
  expect(existsSync(renamed)).toBe(false);
  await clickMenu(app, EDIT, 'redo');
  await expect.poll(() => exists(renamed)).toBe(true);
});
