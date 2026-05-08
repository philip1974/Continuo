// 关闭文件夹 → explorer.json root=null + recentRoots 不丢.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('⋯ 关闭文件夹 → explorer.json root=null,recentRoots 仍 [ws1]', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-cf-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-cf-ws1-'));
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

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    await win.locator('button[aria-label=更多操作]').click();
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: /关闭文件夹/ })
      .click();

    await expect(win.locator('text=未打开文件夹')).toBeVisible({
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

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
