// 关闭文件夹 + 重启 → EmptyWorkspace 显「最近打开」 + ws basename.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('关 folder + 重启 → EmptyWorkspace 显「最近打开」+ ws', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-cfr-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-cfr-ws-'));
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
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.locator('button[aria-label=更多操作]').click();
    await win1
      .getByRole('menu')
      .getByRole('menuitem', { name: /关闭文件夹/ })
      .click();
    await expect(win1.locator('text=未打开文件夹')).toBeVisible({
      timeout: 5_000,
    });

    // 等持久化
    await win1.waitForTimeout(800);
    await app1.close();

    // 第二次:重启
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // 仍 EmptyWorkspace
    await expect(win2.locator('text=未打开文件夹')).toBeVisible({
      timeout: 10_000,
    });
    // 「最近打开」 list 含 ws
    await expect(win2.locator('text=最近打开')).toBeVisible();
    const wsName = path.basename(ws);
    await expect(
      win2.getByRole('menuitem', { name: new RegExp(wsName) }),
    ).toBeVisible();

    await app2.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
