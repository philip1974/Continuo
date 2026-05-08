// Cmd+P 自动排除 node_modules / .git / dist 等内文件.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('node_modules / .git / dist 内文件不在 Cmd+P 列表', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qo-noise-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qo-noise-ws-'));
  try {
    mkdirSync(path.join(ws, 'node_modules/somepkg'), { recursive: true });
    mkdirSync(path.join(ws, '.git'), { recursive: true });
    mkdirSync(path.join(ws, 'dist'), { recursive: true });
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(
      path.join(ws, 'node_modules/somepkg/should-not-appear.ts'),
      'noise',
    );
    writeFileSync(path.join(ws, '.git/HEAD'), 'noise');
    writeFileSync(path.join(ws, 'dist/built.js'), 'noise');
    writeFileSync(path.join(ws, 'src/visible.ts'), 'visible\n');
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
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(win.locator('.wm-modal-content')).toContainText(
      'visible.ts',
      { timeout: 10_000 },
    );

    const text = (
      await win.locator('.wm-modal-content li').allTextContents()
    ).join('\n');
    expect(text).not.toContain('should-not-appear');
    expect(text).not.toContain('HEAD');
    expect(text).not.toContain('built.js');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
