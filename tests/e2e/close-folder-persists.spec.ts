// 关闭文件夹 → explorer.json root=null + recentRoots 不丢.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const MORE_ACTIONS = /^(更多操作|More actions|추가 작업)$/;
const CLOSE_FOLDER = /^(关闭文件夹|Close folder|폴더 닫기)$/;
const NO_FOLDER_OPEN = /^(未打开文件夹|No folder open|열린 폴더 없음)$/;

test('⋯ 关闭文件夹 → explorer.json root=null,recentRoots 仍 [ws1]', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-cf-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-cf-ws1-'));
  let app: ElectronApplication | undefined;
  try {
    writeFileSync(path.join(ws1, 'a.md'), '# 1\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1] },
        explorer: {
          activePath: null,
          expandedPaths: [ws1],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
      }),
    );

    app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const explorerSidebar = win
      .locator('aside')
      .filter({ has: win.getByTitle(ws1, { exact: true }) });
    await explorerSidebar.getByRole('button', { name: MORE_ACTIONS }).click();
    await win.getByRole('menu').getByRole('menuitem', { name: CLOSE_FOLDER }).click();

    await expect(win.getByText(NO_FOLDER_OPEN)).toBeVisible({
      timeout: 5_000,
    });

    // 等 debounce
    await win.waitForTimeout(800);

    const raw = readFileSync(path.join(ud, 'explorer.json'), 'utf8');
    const data = JSON.parse(raw) as {
      workspace: { root: string | null; recentRoots: string[] };
    };
    expect(data.workspace.root).toBeNull();
    expect(data.workspace.recentRoots).toContain(ws1);
  } finally {
    await app?.close();
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
