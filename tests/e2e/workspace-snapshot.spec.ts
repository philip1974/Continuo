// 按文件夹的会话快照(VSCode workspace storage):关掉文件夹的窗口后再打开它 / 同一窗口切走再切回,编辑器 tab 与侧栏回来。
// BDD: src/__tests__/workspace-snapshot/
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { EXPLORER_HIDE, EXPLORER_SHOW, explorerMoreActionsButton, explorerSidebar } from './helpers/explorer';
import { DOCK_POPOUT, editorTab, openWorkspaceFile } from './helpers/editor';
import { closeDiscardingUnsaved } from './helpers/close-app';
import { launchContinuo } from './helpers/launch';
import { seedExplorerJson } from './helpers/seed-explorer';
import { waitForAppReady } from './helpers/app-ready';
import { readPersistedExplorer } from './helpers/persisted-explorer';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];

test.afterEach(async () => {
  for (const app of apps.splice(0)) await closeDiscardingUnsaved(app).catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface DiskWindow {
  windowSeq: number;
  workspace: { root: string | null };
  layoutUi?: { sidebarOpen: boolean };
  editor?: { openFilePaths: string[] };
}
interface Disk {
  windows: DiskWindow[];
  workspaceSnapshots?: { workspace: { root: string }; editor?: { openFilePaths: string[] } }[];
}

function readDisk(ud: string): Disk | null {
  try {
    return readPersistedExplorer(ud) as Disk;
  } catch {
    return null;
  }
}

async function openFolderInNewWindow(app: ElectronApplication, dir: string): Promise<Page> {
  const next = app.waitForEvent('window');
  // e2e 下应用菜单被禁用,走 macOS open-file(拖文件夹到 Dock)入口:与「在新窗口打开文件夹」同一 openWorkspaceWindowWith。
  await app.evaluate(({ app: electronApp }, p) => {
    electronApp.emit('open-file', { preventDefault: () => undefined }, p);
  }, dir);
  const page = await next;
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  return page;
}

test('复现 a:ws2 窗口开着 w1.ts、侧栏隐藏 → 关掉窗口 → 再打开 ws2,tab 与侧栏状态回来', async () => {
  test.setTimeout(120_000);
  const ud = tempDir('wssnap-ud-');
  const ws1 = tempDir('wssnap-ws1-');
  const ws2 = tempDir('wssnap-ws2-');
  writeFileSync(path.join(ws1, 'marker.txt'), 'x\n');
  writeFileSync(path.join(ws2, 'w1.ts'), 'export const w1 = 1;\n');
  seedExplorerJson(ud, { root: ws1 });
  const app = await launchContinuo(ud);
  apps.push(app);
  const main = await app.firstWindow();
  await expect(explorerSidebar(main)).toContainText('marker.txt', { timeout: 15_000 });

  const first = await openFolderInNewWindow(app, ws2);
  const seq = new URL(first.url()).searchParams.get('windowSeq');
  await openWorkspaceFile(first, ['w1.ts']);
  await first.getByRole('button', { name: EXPLORER_HIDE }).click();
  await expect
    .poll(() => {
      const w = readDisk(ud)?.windows.find((x) => String(x.windowSeq) === seq);
      return [w?.editor?.openFilePaths.some((p) => p.endsWith('w1.ts')), w?.layoutUi?.sidebarOpen];
    }, { timeout: 10_000 })
    .toEqual([true, false]);

  // 关掉这个窗口(走关窗 flush)
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()
      .find((w) => new URL(w.webContents.getURL()).searchParams.get('windowSeq') === s)!
      .close();
  }, seq!);
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
  await expect
    .poll(() => readDisk(ud)?.workspaceSnapshots?.some((s) => s.editor?.openFilePaths.some((p) => p.endsWith('w1.ts'))), {
      timeout: 10_000,
    })
    .toBe(true);

  const reopened = await openFolderInNewWindow(app, ws2);
  expect(new URL(reopened.url()).searchParams.get('windowSeq')).not.toBe(seq);
  await expect(editorTab(reopened, 'w1.ts')).toBeVisible({ timeout: 15_000 });
  await expect(reopened.getByRole('button', { name: EXPLORER_SHOW })).toBeVisible();
});

// VSCode:辅助窗口随工作区恢复。快照带 dock 布局(含 popout 组),重开该文件夹时子窗随布局恢复。
test('ws2 窗口有弹出的子窗 → 关掉 → 再打开 ws2,子窗随布局恢复', async () => {
  test.setTimeout(120_000);
  const ud = tempDir('wssnap-ud-');
  const ws1 = tempDir('wssnap-ws1-');
  const ws2 = tempDir('wssnap-ws2-');
  writeFileSync(path.join(ws1, 'marker.txt'), 'x\n');
  writeFileSync(path.join(ws2, 'w1.ts'), 'export const w1 = 1;\n');
  seedExplorerJson(ud, { root: ws1 });
  const app = await launchContinuo(ud);
  apps.push(app);
  const main = await app.firstWindow();
  await expect(explorerSidebar(main)).toContainText('marker.txt', { timeout: 15_000 });

  const first = await openFolderInNewWindow(app, ws2);
  const seq = new URL(first.url()).searchParams.get('windowSeq');
  await openWorkspaceFile(first, ['w1.ts']);
  await first.getByRole('button', { name: DOCK_POPOUT }).first().click();
  await expect.poll(() => app.windows().length, { timeout: 10_000 }).toBe(3);
  await expect
    .poll(() => {
      const w = readDisk(ud)?.windows.find((x) => String(x.windowSeq) === seq) as { layout?: { popoutGroups?: unknown[] } };
      return w?.layout?.popoutGroups?.length ?? 0;
    }, { timeout: 10_000 })
    .toBe(1);

  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()
      .find((w) => new URL(w.webContents.getURL()).searchParams.get('windowSeq') === s)!
      .close();
  }, seq!);
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);

  const reopened = await openFolderInNewWindow(app, ws2);
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(3);
  const child = app.windows().find((w) => w !== main && w !== reopened)!;
  await expect(child.locator('[data-testid=popout-host]')).toBeVisible({ timeout: 10_000 });
  await expect(editorTab(child, 'w1.ts')).toBeVisible({ timeout: 10_000 });
});

test('复现 b:同一窗口 ws2(w2.ts)→ 切到 ws3 → 切回 ws2,w2.ts 回来', async () => {
  test.setTimeout(90_000);
  const ud = tempDir('wssnap-ud-');
  const ws2 = tempDir('wssnap-ws2-');
  const ws3 = tempDir('wssnap-ws3-');
  writeFileSync(path.join(ws2, 'w2.ts'), 'export const w2 = 2;\n');
  writeFileSync(path.join(ws3, 'only-in-ws3.txt'), '3\n');
  seedExplorerJson(ud, { root: ws2, recentRoots: [ws2, ws3] });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await openWorkspaceFile(win, ['w2.ts']);
  await expect(editorTab(win, 'w2.ts')).toBeVisible({ timeout: 10_000 });

  const switchTo = async (dir: string): Promise<void> => {
    await explorerMoreActionsButton(win).click();
    await win.getByRole('menuitem', { name: path.basename(dir), exact: false }).click();
  };

  await switchTo(ws3);
  await expect(explorerSidebar(win)).toContainText('only-in-ws3.txt', { timeout: 10_000 });
  await expect(editorTab(win, 'w2.ts')).toHaveCount(0);

  await switchTo(ws2);
  await expect(explorerSidebar(win)).not.toContainText('only-in-ws3.txt', { timeout: 10_000 });
  await expect(editorTab(win, 'w2.ts')).toBeVisible({ timeout: 10_000 });
});

// VSCode workspace storage 只记属于该文件夹的编辑器:同一窗口切走时保留的未保存 tab(别的文件夹的文件)不能记进当前文件夹的
// 快照。此前 ws1 的 file-1.ts 随 ws3 的快照进了「在新窗口打开 ws3」的窗口(标题「file-1.ts · ws3」,同一文件两个窗口同时打开)。
test('复现 c:ws1 的未保存 tab 带到 ws3 → 切回 ws1 保存 → 新窗口打开 ws3,只恢复 ws3 自己的 tab', async () => {
  test.setTimeout(120_000);
  const ud = tempDir('ui98b-ud-');
  const ws1 = tempDir('ui98b-ws1-');
  const ws3 = tempDir('ui98b-ws3-');
  writeFileSync(path.join(ws1, 'file-1.ts'), 'export const one = 1;\n');
  writeFileSync(path.join(ws3, 'b3.ts'), 'export const b3 = 3;\n');
  seedExplorerJson(ud, { root: ws1, recentRoots: [ws1, ws3] });
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  await openWorkspaceFile(win, ['file-1.ts']);
  await win.locator('.cm-content').first().click();
  await win.keyboard.press('ControlOrMeta+End');
  await win.keyboard.type('// dirty\n');

  const switchTo = async (dir: string): Promise<void> => {
    await explorerMoreActionsButton(win).click();
    await win.getByRole('menuitem', { name: path.basename(dir), exact: false }).click();
  };

  await switchTo(ws3);
  await expect(explorerSidebar(win)).toContainText('b3.ts', { timeout: 10_000 });
  await expect(editorTab(win, 'file-1.ts')).toBeVisible(); // 未保存的 tab 按设计保留
  await openWorkspaceFile(win, ['b3.ts']);

  await switchTo(ws1);
  await expect(explorerSidebar(win)).not.toContainText('b3.ts', { timeout: 10_000 });
  await editorTab(win, 'file-1.ts').click();
  await win.locator('.cm-content').first().click();
  await win.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => readFileSync(path.join(ws1, 'file-1.ts'), 'utf8'), { timeout: 10_000 }).toContain('// dirty');

  // 盘上 ws3 的快照只有 ws3 自己的文件
  await expect
    .poll(() => {
      const s = readDisk(ud)?.workspaceSnapshots?.find((x) => x.workspace.root.endsWith(path.basename(ws3)));
      return s?.editor?.openFilePaths.map((p) => path.basename(p));
    }, { timeout: 10_000 })
    .toEqual(['b3.ts']);

  const other = await openFolderInNewWindow(app, ws3);
  await expect(editorTab(other, 'b3.ts')).toBeVisible({ timeout: 15_000 });
  await expect(editorTab(other, 'file-1.ts')).toHaveCount(0);
  expect(await other.title()).not.toContain('file-1.ts');
});
