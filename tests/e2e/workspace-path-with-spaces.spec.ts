// workspace path 含空格 → 加载 + tree + Cmd+P 都正常.  @edge
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('ws path 含空格 → 正常', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sp-'));
  // path with space
  const parent = mkdtempSync(path.join(tmpdir(), 'continuo-sp-parent-'));
  const ws = path.join(parent, 'with space ws');
  mkdirSync(ws, { recursive: true });
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

    // tree 渲
    await expect(win.locator('text=README.md').first()).toBeVisible({
      timeout: 10_000,
    });

    // Cmd+P
    await win.evaluate(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'p',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(
      win.locator('.wm-modal-content input[placeholder*="搜索文件名"]'),
    ).toBeVisible();
    await expect(win.locator('.wm-modal-content')).toContainText(
      'README.md',
      { timeout: 10_000 },
    );

    await app.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
