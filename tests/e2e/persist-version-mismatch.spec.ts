// explorer.json version=99(未来版本/损坏)→ schema 校验失败 → fallback EmptyWorkspace.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('version=99 → fallback EmptyWorkspace + 不抛', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-v99-'));
  try {
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 99,
        workspace: { root: '/whatever', recentRoots: [] },
        explorer: {
          activePath: null,
          expandedPaths: [],
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

    await expect(win.locator('text=未打开文件夹')).toBeVisible({
      timeout: 10_000,
    });
    await app.close();
  } finally {
    rmSync(ud, { recursive: true, force: true });
  }
});
