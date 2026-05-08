// 文件名含空格/中文 → tree 显示 + 单击打开 + header 显原名.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('我的笔记.md / with space.txt 都可打开', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sf-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-sf-ws-'));
  try {
    writeFileSync(path.join(ws, '我的笔记.md'), '# zh\n');
    writeFileSync(path.join(ws, 'with space.txt'), 'spaced\n');
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

    // 点中文文件
    await win.locator('text=我的笔记.md').first().click();
    await expect(win.locator('header').first()).toContainText('我的笔记.md', {
      timeout: 10_000,
    });

    // 点空格文件
    await win.locator('text=with space.txt').first().click();
    await expect(win.locator('header').first()).toContainText(
      'with space.txt',
    );

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
