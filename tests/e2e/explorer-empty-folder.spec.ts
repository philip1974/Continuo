// 打开一个空文件夹 workspace → Explorer 显示 workspace 名 + 空内容.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('空 workspace → 渲染 workspace name + 没有 treeitem', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-empty-ws-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-empty-ws-root-'));
  try {
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

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // ExplorerHeader 显 workspace name
    const wsName = path.basename(ws);
    await expect(
      win.locator('main aside').nth(1).getByText(wsName).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Tree 0 个 treeitem(空 root)
    await expect(win.locator('[role=treeitem]')).toHaveCount(0);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
