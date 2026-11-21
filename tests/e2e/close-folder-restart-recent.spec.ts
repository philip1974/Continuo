// 关闭文件夹 + 重启 → EmptyWorkspace 显「最近打开」 + ws basename.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const MORE_ACTIONS = /^(更多操作|More actions|추가 작업)$/;
const CLOSE_FOLDER = /^(关闭文件夹|Close folder|폴더 닫기)$/;
const NO_FOLDER_OPEN = /^(未打开文件夹|No folder open|열린 폴더 없음)$/;
const RECENT = /^(最近打开|Recent|최근 열기)$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('关 folder + 重启 → EmptyWorkspace 显「最近打开」+ ws', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-cfr-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-cfr-ws-'));
  let app1: ElectronApplication | undefined;
  let app2: ElectronApplication | undefined;
  try {
    writeFileSync(path.join(ws, 'a.md'), '# 1\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws, recentRoots: [ws] },
        explorer: {
          activePath: null,
          expandedPaths: [ws],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    // 第一次:关 folder
    app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    const explorerSidebar = win1
      .locator('aside')
      .filter({ has: win1.getByTitle(ws, { exact: true }) });
    await explorerSidebar.getByRole('button', { name: MORE_ACTIONS }).click();
    await win1
      .getByRole('menu')
      .getByRole('menuitem', { name: CLOSE_FOLDER })
      .click();
    await expect(win1.getByText(NO_FOLDER_OPEN)).toBeVisible({
      timeout: 5_000,
    });

    // 等持久化
    await win1.waitForTimeout(800);
    await app1.close();
    app1 = undefined;

    // 第二次:重启
    app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // 仍 EmptyWorkspace
    await expect(win2.getByText(NO_FOLDER_OPEN)).toBeVisible({
      timeout: 10_000,
    });
    // 「最近打开」 list 含 ws
    await expect(win2.getByRole('list', { name: RECENT })).toBeVisible();
    await expect(
      win2.getByRole('button', { name: new RegExp(escapeRegExp(ws)) }),
    ).toBeVisible();
  } finally {
    await app2?.close();
    await app1?.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
