// 用户选定的编码跨重启 / 按文件夹快照恢复(VSCode FileEditorInput 序列化 encoding):GBK 与无 BOM 的 UTF-16 LE tab 重启后按原编码
// 恢复;同一窗口切走再切回同样;文件已换成别的编码 → 不打开、提示「恢复失败」并可「通过编码重新打开」。
// BDD: src/__tests__/editor-text-encoding/(encoding-restart.spec.ts)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { editorTab } from './helpers/editor';
import { explorerMoreActionsButton, explorerSidebar, explorerTreeItem } from './helpers/explorer';
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

async function launch(ud: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await launchContinuo(ud);
  apps.push(app);
  const win = await app.firstWindow();
  await waitForAppReady(win);
  return { app, win };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  apps.splice(apps.indexOf(app), 1);
  await closeDiscardingUnsaved(app);
}

const encodingItem = (win: Page) => win.locator('footer [data-statusbar-encoding]');
const pick = (win: Page, id: string) => win.locator(`.wm-modal-content [data-encoding-pick="${id}"]`);
const GBK_TEXT = '中文内容\n';
// 无 BOM、全是 CJK 的 UTF-16 LE:没有 0 字节也不是合法 UTF-8 → 自动识别不出,打开时要选编码(重启后同样识别不出)
const U16_TEXT = '中文内容';

function writeFiles(ws: string): void {
  writeFileSync(path.join(ws, 'gbk.txt'), iconv.encode(GBK_TEXT, 'gbk'));
  writeFileSync(path.join(ws, 'u16.txt'), Buffer.from(U16_TEXT, 'utf16le'));
}

/** 资源管理器单击 → 编码选择器选 id → 打开;双击 tab 转常驻(单击打开的是预览 tab,再打开别的会被替换)。 */
async function openWithEncoding(win: Page, name: string, id: string): Promise<void> {
  await explorerTreeItem(win, new RegExp(`^${name.replace('.', '\\.')}$`)).click();
  await expect(pick(win, id)).toBeVisible({ timeout: 10_000 });
  await pick(win, id).click();
  await expect(editorTab(win, name)).toBeVisible({ timeout: 10_000 });
  await editorTab(win, name).dblclick();
}

async function expectTabEncoding(win: Page, name: string, text: string, label: string): Promise<void> {
  await editorTab(win, name).click();
  await expect(win.locator('.cm-content').first()).toContainText(text, { timeout: 10_000 });
  await expect(encodingItem(win)).toHaveText(label);
}

function diskEncodings(ud: string): unknown {
  try {
    const disk = readPersistedExplorer(ud) as {
      windows: { editor?: { encodings?: { path: string; encoding: string }[] } }[];
    };
    return (disk.windows[0]?.editor?.encodings ?? []).map((e) => `${path.basename(e.path)}:${e.encoding}`).sort();
  } catch {
    return null;
  }
}

test('GBK 与无 BOM 的 UTF-16 LE tab 重启后按原编码恢复;文件换了编码 → 提示「恢复失败」,可通过编码重新打开', async () => {
  test.setTimeout(120_000);
  const ud = tempDir('ui125-ud-');
  const ws = tempDir('ui125-ws-');
  writeFiles(ws);
  seedExplorerJson(ud, { root: ws });

  let { app, win } = await launch(ud);
  await openWithEncoding(win, 'gbk.txt', 'gbk');
  await openWithEncoding(win, 'u16.txt', 'utf16le');
  await expectTabEncoding(win, 'u16.txt', U16_TEXT, 'UTF-16 LE');
  await expect.poll(() => diskEncodings(ud), { timeout: 10_000 }).toEqual(['gbk.txt:gbk', 'u16.txt:utf16le']);
  await closeApp(app);

  ({ app, win } = await launch(ud));
  await expect(editorTab(win, 'gbk.txt')).toBeVisible({ timeout: 15_000 });
  await expect(editorTab(win, 'u16.txt')).toBeVisible();
  await expectTabEncoding(win, 'gbk.txt', '中文内容', 'GBK');
  await expectTabEncoding(win, 'u16.txt', U16_TEXT, 'UTF-16 LE');
  // 不弹编码选择器(按记录的编码直接读)
  await expect(pick(win, 'gbk')).toHaveCount(0);
  await closeApp(app);

  // 外部把 gbk.txt 换成 Shift JIS(末尾半角片假名单字节在 GBK 下不完整 → 按 GBK 解码不可逆)
  writeFileSync(path.join(ws, 'gbk.txt'), iconv.encode('aｱ', 'shiftjis'));
  ({ app, win } = await launch(ud));
  await expect(editorTab(win, 'u16.txt')).toBeVisible({ timeout: 15_000 });
  await expect(editorTab(win, 'gbk.txt')).toHaveCount(0);
  await expect(win.getByText(/(恢复失败|Failed to restore|복원 실패) gbk\.txt/).first()).toBeVisible({ timeout: 10_000 });
  await win.getByRole('button', { name: /^(通过编码重新打开|Reopen with Encoding|인코딩하여 다시 열기)$/ }).click();
  await expect(pick(win, 'shiftjis')).toBeVisible({ timeout: 10_000 });
  await pick(win, 'shiftjis').click();
  await expectTabEncoding(win, 'gbk.txt', 'aｱ', 'Shift JIS');
});

test('按文件夹快照:同一窗口切走再切回,GBK / UTF-16 LE tab 按原编码恢复', async () => {
  test.setTimeout(120_000);
  const ud = tempDir('ui125-ud-');
  const ws2 = tempDir('ui125-ws2-');
  const ws3 = tempDir('ui125-ws3-');
  writeFiles(ws2);
  writeFileSync(path.join(ws3, 'only-in-ws3.txt'), '3\n');
  seedExplorerJson(ud, { root: ws2, recentRoots: [ws2, ws3] });
  const { win } = await launch(ud);
  await openWithEncoding(win, 'gbk.txt', 'gbk');
  await openWithEncoding(win, 'u16.txt', 'utf16le');

  const switchTo = async (dir: string): Promise<void> => {
    await explorerMoreActionsButton(win).click();
    await win.getByRole('menuitem', { name: path.basename(dir), exact: false }).click();
  };
  await switchTo(ws3);
  await expect(explorerSidebar(win)).toContainText('only-in-ws3.txt', { timeout: 10_000 });
  await expect(editorTab(win, 'gbk.txt')).toHaveCount(0);

  await switchTo(ws2);
  await expect(editorTab(win, 'gbk.txt')).toBeVisible({ timeout: 10_000 });
  await expect(editorTab(win, 'u16.txt')).toBeVisible();
  await expectTabEncoding(win, 'gbk.txt', '中文内容', 'GBK');
  await expectTabEncoding(win, 'u16.txt', U16_TEXT, 'UTF-16 LE');
  await expect(pick(win, 'gbk')).toHaveCount(0);
});
