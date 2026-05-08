// Quick Open walk 不过滤 dot 文件,虽然 tree 默认过滤.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('Cmd+P 列表含 .secret.md(虽 tree 默认不显)', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qodot-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qodot-ws-'));
  try {
    writeFileSync(path.join(ws, '.secret.md'), '# secret\n');
    writeFileSync(path.join(ws, 'visible.txt'), 'x\n');
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

    // Tree 默认不显 .secret.md(showHiddenFiles=false)
    await expect(
      win.locator('[role=treeitem]').filter({ hasText: /^\.secret\.md$/ }),
    ).toHaveCount(0);

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
    const input = win.locator(
      '.wm-modal-content input[placeholder*="搜索文件名"]',
    );
    await expect(input).toBeVisible();
    await expect(win.locator('.wm-modal-content')).toContainText(
      'visible.txt',
      { timeout: 10_000 },
    );

    // 输 secret → 列出 .secret.md
    await input.fill('secret');
    await expect(
      win.locator('.wm-modal-content li').first(),
    ).toContainText('.secret.md');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
