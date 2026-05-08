// 含 CRLF 行尾的 file 打开不崩 + footer 显行数.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('CRLF file → 打开不崩 + footer 显行数', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-crlf-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-crlf-ws-'));
  try {
    writeFileSync(
      path.join(ws, 'win.txt'),
      'line1\r\nline2\r\nline3\r\n',
    );
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

    await win.locator('text=win.txt').first().click();
    await expect(win.locator('header').first()).toContainText('win.txt', {
      timeout: 10_000,
    });

    // CodeMirror 渲 + footer 行数显示
    await expect(win.locator('.cm-content').first()).toBeVisible();
    await expect(win.locator('footer')).toContainText(/\d+\s*行/);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
