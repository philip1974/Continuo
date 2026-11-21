// 含中文 / emoji / 多字节字符的 file → CM 正确显示.  @edge
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('Unicode/中文/emoji file → CM 正确显示', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-uni-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-uni-ws-'));
  try {
    writeFileSync(
      path.join(ws, 'unicode.txt'),
      '你好世界 🌍\nこんにちは 🇯🇵\n한국어 ✨\n',
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

    await win.locator('text=unicode.txt').first().click();
    const cm = win.locator('.cm-content').first();
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await expect(cm).toContainText('你好世界');
    await expect(cm).toContainText('한국어');
    await expect(cm).toContainText('🌍');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
