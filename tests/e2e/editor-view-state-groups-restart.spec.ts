// 编辑器视图状态按「编辑器组 + 文件」跨重启(VSCode EditorMemento:按组分别保存每个文件的视图状态,含折叠区域)。
// BDD: src/__tests__/editor-view-state-groups/
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openWorkspaceFile } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const apps: Awaited<ReturnType<typeof launchContinuo>>[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(ud: string): Promise<Page> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return win;
}

const LONG = Array.from({ length: 400 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n';

function workspace(files: Record<string, string>): string {
  const ud = mkdtempSync(path.join(tmpdir(), 'ui95a-ud-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'ui95a-ws-'));
  dirs.push(ud, ws);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(ws, name), text);
  seedExplorerJson(ud, { root: ws });
  return ud;
}

const groups = (win: Page): Locator => win.locator('[data-editor-panel-root]');
const group = (win: Page, i: number): Locator => groups(win).nth(i);

interface ViewInfo {
  readonly cursorLine: number;
  /** 光标行是否在视口内(滚动区可见范围)。 */
  readonly cursorVisible: boolean;
}

type CmView = {
  state: { doc: { line(n: number): { from: number }; lineAt(pos: number): { number: number } }; selection: { main: { head: number } } };
  scrollDOM: HTMLElement;
  coordsAtPos(pos: number): { top: number; bottom: number } | null;
  dispatch(spec: unknown): void;
  constructor: { scrollIntoView(pos: number, opts: { y: 'center' }): unknown };
};

/** 组 g 的 CodeMirror 视图(.cm-content 的 tile 根)。 */
const viewInfo = (g: Locator): Promise<ViewInfo | null> =>
  g.locator('.cm-content').evaluate((el) => {
    const view = (el as unknown as { cmTile?: { root?: { view?: CmView } } }).cmTile?.root?.view;
    if (!view) return null;
    const head = view.state.selection.main.head;
    const at = view.coordsAtPos(head);
    const box = view.scrollDOM.getBoundingClientRect();
    return {
      cursorLine: view.state.doc.lineAt(head).number,
      // 光标所在行整行落在滚动区可见范围内
      cursorVisible: at !== null && box.height > 0 && at.top >= box.top && at.bottom <= box.bottom,
    };
  });

/** 把组 g 的光标移到第 line 行并滚进视口(等同用户移动光标)。 */
async function moveCursor(g: Locator, line: number): Promise<void> {
  await g.locator('.cm-content').evaluate((el, n) => {
    const view = (el as unknown as { cmTile?: { root?: { view?: CmView } } }).cmTile!.root!.view!;
    const at = view.state.doc.line(n).from;
    // 居中滚到光标处(EditorView.scrollIntoView;view.constructor 即页面里的 EditorView 类)
    view.dispatch({ selection: { anchor: at }, effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
  }, line);
  await expect.poll(async () => (await viewInfo(g))?.cursorVisible).toBe(true);
}

test('同一文件在两个组:重启后各组恢复各自的光标与视口,再重启一次仍各自保持', async () => {
  test.setTimeout(120_000);
  const ud = workspace({ 'long.ts': LONG });
  const win1 = await launch(ud);
  await openWorkspaceFile(win1, ['long.ts']);
  await expect(group(win1, 0).locator('.cm-content')).toBeVisible({ timeout: 10_000 });
  await group(win1, 0).locator('.cm-content').click();
  await moveCursor(group(win1, 0), 300);
  await win1.keyboard.press('ControlOrMeta+Backslash');
  await expect(groups(win1)).toHaveCount(2, { timeout: 10_000 });
  await expect.poll(async () => (await viewInfo(group(win1, 1)))?.cursorLine).toBe(300);
  await moveCursor(group(win1, 1), 10);
  await expect.poll(async () => (await viewInfo(group(win1, 0)))?.cursorLine).toBe(300);
  await closeDiscardingUnsaved(apps.pop()!);

  for (const round of [1, 2]) {
    const win = await launch(ud);
    await expect(groups(win)).toHaveCount(2, { timeout: 15_000 });
    await expect
      .poll(async () => [await viewInfo(group(win, 0)), await viewInfo(group(win, 1))], { message: `restart ${round}` })
      .toEqual([
        { cursorLine: 300, cursorVisible: true },
        { cursorLine: 10, cursorVisible: true },
      ]);
    // 不做任何操作直接退出:盘上的视图状态不被改写
    await closeDiscardingUnsaved(apps.pop()!);
  }
});

const BAD_JS = [
  'function alpha() {',
  '  const a = 1;',
  '  const b = 2;',
  '  return a + b;',
  '}',
  '',
  'function beta() {',
  '  return 3;',
  '}',
  '',
].join('\n');

test('代码折叠跨重启恢复', async () => {
  test.setTimeout(90_000);
  const ud = workspace({ 'bad.js': BAD_JS });
  const win1 = await launch(ud);
  await openWorkspaceFile(win1, ['bad.js']);
  const cm1 = win1.locator('.cm-content');
  await expect(cm1).toContainText('function alpha()', { timeout: 10_000 });
  await win1.locator('.cm-line', { hasText: 'function alpha()' }).click();
  await win1.keyboard.press('ControlOrMeta+Alt+BracketLeft');
  await expect(win1.locator('.cm-foldPlaceholder')).toHaveCount(1);
  await expect(win1.locator('.cm-line', { hasText: 'const b = 2;' })).toHaveCount(0);
  await closeDiscardingUnsaved(apps.pop()!);

  const win2 = await launch(ud);
  await expect(win2.locator('.cm-content')).toContainText('function beta()', { timeout: 15_000 });
  await expect(win2.locator('.cm-foldPlaceholder')).toHaveCount(1);
  await expect(win2.locator('.cm-line', { hasText: 'const b = 2;' })).toHaveCount(0);
  await expect(win2.locator('.cm-line', { hasText: 'function alpha()' })).toHaveCount(1);
});
