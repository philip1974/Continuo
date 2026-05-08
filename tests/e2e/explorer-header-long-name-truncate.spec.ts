// 长 workspace 名 → ExplorerHeader 标题元素 class 含 truncate.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('长 workspace 名 → ExplorerHeader 标题 class 含 truncate', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-long-'));
  // 超长名:80+ 字符
  const longName = 'this-is-a-very-very-very-long-workspace-folder-name-for-truncate-testing';
  const ws = mkdtempSync(path.join(tmpdir(), `continuo-${longName}-`));
  try {
    writeFileSync(path.join(ws, 'README.md'), '# x\n');
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

    const aside = win.locator('main aside').nth(1);
    const titleSpan = aside.locator('span.truncate').first();
    await expect(titleSpan).toBeVisible({ timeout: 10_000 });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
