// charCount 用 s.length(UTF-16 code unit)→ '🌍' = 2 字符.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('🌍 file → footer 显「2 字符」(UTF-16 代码单元)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-emoji-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-emoji-ws-'));
  try {
    writeFileSync(path.join(ws, 'emoji.txt'), '🌍');
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

    await win.locator('text=emoji.txt').first().click();
    await expect(win.locator('header').first()).toContainText('emoji.txt', {
      timeout: 10_000,
    });

    const footer = win.locator('footer');
    // '🌍'.length === 2(UTF-16)
    await expect(footer).toContainText(/2\s*字符/);

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
