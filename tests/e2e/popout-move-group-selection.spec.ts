// 「查看: 将组移到新窗口」后光标 / 选区不变(VSCode Move Editor Group into New Window 同):此前子窗里滚动与折叠保留,
// 选区却变成第 1 行(CodeMirror 缓存的 DOM 选区随节点挪进子窗后仍「等价」,获焦时不写进子窗文档;子窗随后报告的默认起点
// 选区覆盖 state),接着输入插到文件开头。收回主窗、再次弹出同理。Markdown 编辑模式(ProseMirror)一并验证。
// BDD: src/__tests__/editor-popout-root/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { EDITOR_MODE_EDIT, editorModeButton, openWorkspaceFile } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady, waitForTestHooks } from './helpers/app-ready';

const MOVE_GROUP = 'workbench.action.moveEditorGroupToNewWindow';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launchWith(files: Record<string, string>): Promise<{ app: ElectronApplication; win: Page }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui98b-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui98b-ws-'));
  dirs.push(ud, ws);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(ws, name), text);
  seedExplorerJson(ud, { root: ws });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await waitForTestHooks(win);
  await noFocusEmulation(win);
  return { app, win };
}

/** 关掉焦点模拟:窗口真实获焦 / 失焦(BrowserWindow.focus 切换),同用户操作。 */
async function noFocusEmulation(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
}

async function focusWindowOf(app: ElectronApplication, page: Page): Promise<void> {
  const url = page.url();
  await app.evaluate(({ BrowserWindow }, u) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u)?.focus();
  }, url);
}

type CmView = {
  state: {
    doc: { line(n: number): { from: number; text: string }; lineAt(pos: number): { number: number } };
    selection: { main: { head: number } };
  };
  dispatch(spec: unknown): void;
  constructor: { scrollIntoView(pos: number, opts: { y: 'center' }): unknown };
};

const content = (scope: Page | Locator): Locator => scope.locator('[data-editor-panel-root] .cm-content');

/** 某个 CodeMirror 视图的光标行与指定行的文本。 */
const cmProbe = (cm: Locator, lines: number[]): Promise<{ cursorLine: number; texts: string[] }> =>
  cm.evaluate((el, ns) => {
    const view = (el as unknown as { cmTile: { root: { view: CmView } } }).cmTile.root.view;
    return {
      cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number,
      texts: ns.map((n) => view.state.doc.line(n).text),
    };
  }, lines);

async function moveCursor(cm: Locator, line: number): Promise<void> {
  await cm.evaluate((el, n) => {
    const view = (el as unknown as { cmTile: { root: { view: CmView } } }).cmTile.root.view;
    const at = view.state.doc.line(n).from;
    view.dispatch({ selection: { anchor: at }, effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
  }, line);
}

async function popOutActiveGroup(app: ElectronApplication, win: Page): Promise<Page> {
  const before = app.windows().length;
  await win.evaluate((id) => globalThis.__continuoTest!.executeCommand(id), MOVE_GROUP);
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(before + 1);
  const popout = app.windows().find((w) => w !== win)!;
  await expect(popout.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });
  await noFocusEmulation(popout);
  await focusWindowOf(app, popout);
  return popout;
}

/** 焦点在 page 的编辑器里(弹出 / 收回后焦点交给编辑器)。 */
async function expectEditorFocused(page: Page, selector: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((sel) => document.hasFocus() && document.activeElement?.closest(sel) != null, selector), {
      timeout: 10_000,
    })
    .toBe(true);
}

const LONG = Array.from({ length: 200 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';

test('代码文件:⌘\\ 拆分后将组移到新窗口 → 直接输入落在原光标处;收回主窗、再次弹出同理', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launchWith({ 'long.ts': LONG });
  await openWorkspaceFile(win, ['long.ts']);
  await content(win).first().click();
  await moveCursor(content(win).first(), 150);
  await win.keyboard.press('ControlOrMeta+Backslash');
  await expect(win.locator('[data-editor-panel-root]')).toHaveCount(2, { timeout: 10_000 });
  await expect.poll(async () => (await cmProbe(content(win).nth(1), [150])).cursorLine).toBe(150);

  // 弹出:直接打字
  const child = await popOutActiveGroup(app, win);
  await expectEditorFocused(child, '.cm-content');
  // 子窗获焦后等一会儿(此前子窗随后报告的起点选区在这段时间里覆盖 state)
  await child.waitForTimeout(500);
  await child.keyboard.type('AA');
  await expect
    .poll(() => cmProbe(content(child), [1, 150]))
    .toEqual({ cursorLine: 150, texts: ['const line1 = 1;', 'AAconst line150 = 150;'] });

  // 收回主窗(关子窗):焦点回到收回的编辑器,接着输入仍在原处
  await app.evaluate(({ BrowserWindow }, u) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === u)?.close();
  }, child.url());
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(1);
  await focusWindowOf(app, win);
  await expectEditorFocused(win, '.cm-content');
  await win.waitForTimeout(500);
  await win.keyboard.type('BB');
  const active = win.locator('[data-editor-panel-root] .cm-content:focus');
  await expect.poll(() => cmProbe(active, [1, 150])).toEqual({
    cursorLine: 150,
    texts: ['const line1 = 1;', 'AABBconst line150 = 150;'],
  });

  // 再弹出一次
  const again = await popOutActiveGroup(app, win);
  await expectEditorFocused(again, '.cm-content');
  await again.waitForTimeout(500);
  await again.keyboard.type('CC');
  await expect.poll(() => cmProbe(content(again), [1, 150])).toEqual({
    cursorLine: 150,
    texts: ['const line1 = 1;', 'AABBCCconst line150 = 150;'],
  });
});

const MD = ['# Title', '', ...Array.from({ length: 60 }, (_, i) => `para ${i + 1} text`).flatMap((p) => [p, ''])].join('\n');

test('Markdown 编辑模式:将组移到新窗口 → 直接输入落在原光标处', async () => {
  test.setTimeout(120_000);
  const { app, win } = await launchWith({ 'doc.md': MD });
  await openWorkspaceFile(win, ['doc.md']);
  await editorModeButton(win, EDITOR_MODE_EDIT).click();
  const para = (scope: Page, n: number): Locator => scope.locator('.ProseMirror p', { hasText: new RegExp(`^.*para ${n} text$`) });
  await para(win, 40).scrollIntoViewIfNeeded();
  await para(win, 40).click();
  await win.keyboard.press('End');

  const child = await popOutActiveGroup(app, win);
  await expectEditorFocused(child, '.ProseMirror');
  await child.waitForTimeout(500);
  await child.keyboard.type('ZZ');
  await expect(child.locator('.ProseMirror p', { hasText: 'para 40 textZZ' })).toHaveCount(1, { timeout: 10_000 });
  await expect(child.locator('.ProseMirror h1')).toHaveText('Title');
});
