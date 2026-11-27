// 编辑器查找类命令经命令注册表分发(VSCode actions.find / nextMatchFindAction …,when 含查找控件):改键后旧键失效、新键生效且不被
// CodeMirror 抢走;查找面板里 ⌘F 全选查找词、⌘G / F3 跳下一个;菜单「编辑 → 查找」在 Markdown 编辑 / 预览里打开其查找条。
// BDD: src/__tests__/editor-find-keybindings/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { openTreeItem } from './helpers/explorer';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW, editorModeButton } from './helpers/editor';
import type { AppMenuE2eHook, MenuSnapshotItem } from '../../electron/main/app-menu-e2e';

const isMac = process.platform === 'darwin';
const FIND_NEXT = isMac ? 'Meta+g' : 'F3';
const FIND_INPUT = /^(查找|Find|찾기)$/;
const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui102b-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui102b-ws-'));
  dirs.push(ud, ws);
  writeFileSync(path.join(ws, 'a.ts'), 'foo\nbar foo\nbaz foo\n');
  writeFileSync(path.join(ws, 'notes.md'), '# Notes\n\nalpha beta\n\nbeta gamma\n');
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 关掉 Playwright 的焦点模拟:按真实焦点断言
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  return { app, win };
}

async function openTs(win: Page): Promise<void> {
  await openTreeItem(win, /^a\.ts$/);
  await expect(win.locator('.cm-content')).toContainText('baz foo', { timeout: 10_000 });
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Home');
}

const searchField = (win: Page) => win.locator('.cm-search [main-field]');
const activeLine = (win: Page) => win.locator('.cm-activeLine');

test('⌘F 打开查找面板;面板里再按 ⌘F 全选查找词;⌘G(F3)在查找框里跳下一个', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await openTs(win);
  await win.keyboard.press('ControlOrMeta+f');
  await expect(searchField(win)).toBeFocused();
  await win.keyboard.type('foo');
  await win.keyboard.press('End');
  await win.keyboard.press('ControlOrMeta+f');
  await expect(searchField(win)).toBeFocused();
  expect(await searchField(win).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 3]);
  await win.keyboard.press(FIND_NEXT);
  await win.keyboard.press(FIND_NEXT);
  await win.keyboard.press('Escape');
  await expect(activeLine(win)).toHaveText('bar foo');
});

test('复现:「查找」改到 ⇧⌘G、切换侧栏绑到 ⌘F → 编辑器里 ⌘F 切换侧栏(不打开查找),⇧⌘G 打开查找面板', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await openTs(win);
  await win.evaluate(() => {
    globalThis.__continuoTest!.setHotkey('actions.find', 'mod+shift+g');
    globalThis.__continuoTest!.setHotkey('explorer.toggleSidebar', 'mod+f');
  });
  await win.locator('.cm-content').click();
  const tree = win.getByRole('treeitem', { name: /^a\.ts$/ });
  await expect(tree).toBeVisible();
  await win.keyboard.press('ControlOrMeta+f');
  await expect(tree).toBeHidden();
  await expect(win.locator('.cm-search')).toHaveCount(0);
  await win.locator('.cm-content').click();
  await win.keyboard.press('ControlOrMeta+Shift+g');
  await expect(searchField(win)).toBeFocused();
});

// macOS 顶层:应用 0 / 文件 1 / 编辑 2 …
const EDIT = isMac ? 2 : 1;

async function clickMenu(app: ElectronApplication, id: string): Promise<void> {
  const menu = (await app.evaluate(() =>
    (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.snapshot(),
  )) as MenuSnapshotItem[];
  const i = menu[EDIT]!.submenu!.findIndex((m) => m.id === id);
  expect(i).toBeGreaterThanOrEqual(0);
  const winId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
  const ok = await app.evaluate(
    (_e, { p, winId }) => (globalThis as { __continuoAppMenu?: AppMenuE2eHook }).__continuoAppMenu!.click(p, winId),
    { p: [EDIT, i], winId },
  );
  expect(ok).toBe(true);
}

test('菜单「编辑 → 查找」在 Markdown 编辑 / 预览里打开查找条;「替换」静默', async () => {
  test.setTimeout(90_000);
  const { app, win } = await launch();
  await openTreeItem(win, /^notes\.md$/);
  await editorModeButton(win, EDITOR_MODE_EDIT).click();
  const pm = win.locator('main .milkdown .ProseMirror');
  await expect(pm).toContainText('beta gamma', { timeout: 10_000 });
  await pm.click();
  const findInput = win.getByRole('textbox', { name: FIND_INPUT });

  await clickMenu(app, 'editor.action.startFindReplaceAction');
  await expect(findInput).toHaveCount(0);

  await clickMenu(app, 'actions.find');
  await expect(findInput).toBeFocused();
  await win.keyboard.type('beta');
  await expect(win.locator('main [role="status"]', { hasText: /\d+ \/ 2/ })).toHaveText('1 / 2');
  await win.keyboard.press('Escape');
  await expect(findInput).toHaveCount(0);

  await editorModeButton(win, EDITOR_MODE_PREVIEW).click();
  await expect(pm).toContainText('beta gamma', { timeout: 10_000 });
  await clickMenu(app, 'actions.find');
  await expect(findInput).toBeFocused();
});

test('Markdown 编辑 / 预览里同样跟随改键:「查找」改到 ⇧⌘J、⌘F 绑给切换侧栏、查找下一个改到 ⌘J → 旧键失效且交给新命令', async () => {
  test.setTimeout(90_000);
  const { win } = await launch();
  await openTreeItem(win, /^notes\.md$/);
  await win.evaluate(() => {
    globalThis.__continuoTest!.setHotkey('actions.find', 'mod+shift+j');
    globalThis.__continuoTest!.setHotkey('explorer.toggleSidebar', 'mod+f');
    globalThis.__continuoTest!.setHotkey('editor.action.nextMatchFindAction', 'mod+j');
  });
  const pm = win.locator('main .milkdown .ProseMirror');
  const findInput = win.getByRole('textbox', { name: FIND_INPUT });
  const status = win.locator('main [role="status"]', { hasText: /\d+ \/ 2/ });
  const tree = win.getByRole('treeitem', { name: /^notes\.md$/ });
  for (const mode of [EDITOR_MODE_EDIT, EDITOR_MODE_PREVIEW]) {
    await editorModeButton(win, mode).click();
    await expect(pm).toContainText('beta gamma', { timeout: 10_000 });
    await pm.locator('h1').click();
    // ⌘F:交给切换侧栏(不打开查找条、不被吞)
    await expect(tree).toBeVisible();
    await win.keyboard.press('ControlOrMeta+f');
    await expect(tree).toBeHidden();
    await expect(findInput).toHaveCount(0);
    await win.keyboard.press('ControlOrMeta+f');
    await expect(tree).toBeVisible();
    // ⇧⌘J 打开查找条
    await pm.locator('h1').click();
    await win.keyboard.press('ControlOrMeta+Shift+j');
    await expect(findInput).toBeFocused();
    await findInput.fill('beta');
    await expect(status).toHaveText('1 / 2');
    // 查找下一个:旧键无效,⌘J 生效(查找框里)
    await win.keyboard.press(FIND_NEXT);
    await expect(status).toHaveText('1 / 2');
    await win.keyboard.press('ControlOrMeta+j');
    await expect(status).toHaveText('2 / 2');
    await win.keyboard.press('Escape');
    await expect(findInput).toHaveCount(0);
  }
});
