// 含多行的 file → footer 行数 = 实际行数.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTreeItem } from './helpers/explorer';
import { statusLines } from './helpers/status-bar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('多行 file → footer N 行计数正确', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-lc-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-lc-ws-'));
  try {
    // 5 行(4 个 \n + 末尾 \n)
    writeFileSync(path.join(ws, 'multi.txt'), 'a\nb\nc\nd\ne\n');
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

    await openTreeItem(win, /^multi\.txt$/);
    await expect(win.locator('header').first()).toContainText('multi.txt', {
      timeout: 10_000,
    });

    // lineCount 实现: split('\n').length。'a\nb\nc\nd\ne\n'.split('\n') = 6 段(末尾 \n 后空段)
    const footer = win.locator('footer');
    await expect(footer).toContainText(statusLines(6));

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
