// 1000 字符无换行 → footer 「1 行」.  @edge
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusChars, statusLines } from './helpers/status-bar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('1000 char 无换行 → footer 1 行 + 1000 字符', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sl-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sl-ws-'));
  try {
    const longContent = 'x'.repeat(1000);
    writeFileSync(path.join(ws, 'long.txt'), longContent);
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

    await win.locator('text=long.txt').first().click();
    await expect(win.locator('header').first()).toContainText('long.txt', {
      timeout: 10_000,
    });

    const footer = win.locator('footer');
    // 1000 字符
    await expect(footer).toContainText(statusChars(1000));
    // 1 行(无换行 → 单行)
    await expect(footer).toContainText(statusLines(1));

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
