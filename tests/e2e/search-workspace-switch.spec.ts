// 换文件夹后搜索视图按新根重搜(VSCode SearchView.onDidChangeFolderLocation):⌘O 切文件夹不再列上一个文件夹的结果;
// 关闭文件夹后搜过(「请先打开工作区」)再打开最近的文件夹,不再一直「搜索失败:工作区根目录错误」。
// BDD: src/__tests__/workspace-search/(5 换工作区、4 STALE)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';

const QUERY = /^(搜索|Search|검색)$/;
const STATUS = '[data-testid=search-panel] [role=status]';
const ONE_RESULT = /(1 个文件中有 1 个结果|1 result in 1 file|파일 1개에서 결과 1개)/;
const NO_WORKSPACE = /(请先在资源管理器中打开工作区|Please open a workspace in Explorer first|먼저 탐색기에서 워크스페이스를 여세요)/;
const MORE_ACTIONS = /^(更多操作|More actions|추가 작업)$/;
const CLOSE_FOLDER = /^(关闭文件夹|Close folder|폴더 닫기)$/;

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<{ app: ElectronApplication; win: Page; ws1: string; ws2: string }> {
  const ud = mkdtempSync(path.join(tmpdir(), 'srs-ud-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'srs-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'srs-ws2-'));
  dirs.push(ud, ws1, ws2);
  writeFileSync(path.join(ws1, 'one.md'), 'hello from one\n');
  writeFileSync(path.join(ws2, 'two.md'), 'hello from two\n');
  seedExplorerJson(ud, { root: ws1 });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => win.evaluate(() => globalThis.__continuoTest !== undefined), { timeout: 15_000 }).toBe(true);
  return { app, win, ws1, ws2 };
}

async function search(win: Page, text: string): Promise<void> {
  await win.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
  await win.keyboard.press('ControlOrMeta+Shift+KeyF');
  const input = win.getByRole('textbox', { name: QUERY });
  await expect(input).toBeFocused({ timeout: 10_000 });
  await input.fill(text);
}

const results = (win: Page) =>
  win.getByRole('tree', { name: /^(搜索结果|Search results|검색 결과)$/ }).getByRole('treeitem');

async function openFolder(app: ElectronApplication, win: Page, dir: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
  }, dir);
  expect(await win.evaluate(() => globalThis.__continuoTest!.executeCommand('workbench.action.files.openFolder'))).toBe(true);
}

test('⌘O 切文件夹:结果换成新文件夹的,不用再按 Enter;切回同理', async () => {
  test.setTimeout(90_000);
  const { app, win, ws1, ws2 } = await launch();
  await search(win, 'hello');
  await expect(win.locator(STATUS)).toHaveText(ONE_RESULT, { timeout: 15_000 });
  await expect(results(win).first()).toContainText('one.md');

  await openFolder(app, win, ws2);
  await expect(results(win).first()).toContainText('two.md', { timeout: 15_000 });
  await expect(win.locator(STATUS)).toHaveText(ONE_RESULT);
  await expect(results(win).filter({ hasText: 'one.md' })).toHaveCount(0);

  await openFolder(app, win, ws1);
  await expect(results(win).first()).toContainText('one.md', { timeout: 15_000 });
  await expect(results(win).filter({ hasText: 'two.md' })).toHaveCount(0);
  await expect(win.locator(STATUS)).toHaveText(ONE_RESULT);
});

test('关闭文件夹后搜索(提示先打开工作区)→ 资源管理器「最近打开」打开文件夹 → 出结果,不报工作区根目录错误', async () => {
  test.setTimeout(90_000);
  const { win, ws1 } = await launch();
  const sidebar = win.locator('aside').filter({ has: win.getByTitle(ws1, { exact: true }) });
  await sidebar.getByRole('button', { name: MORE_ACTIONS }).click();
  await win.getByRole('menu').getByRole('menuitem', { name: CLOSE_FOLDER }).click();

  await search(win, 'hello');
  await expect(win.locator(STATUS)).toHaveText(NO_WORKSPACE, { timeout: 10_000 });

  await win.getByRole('button', { name: new RegExp(`^${path.basename(ws1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[，,]`) }).click();
  await expect(win.locator(STATUS)).toHaveText(ONE_RESULT, { timeout: 15_000 });
  await expect(results(win).first()).toContainText('one.md');
});
