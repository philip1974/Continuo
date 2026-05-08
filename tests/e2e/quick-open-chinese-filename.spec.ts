// Cmd+P 输中文 → 匹配中文文件名.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('Cmd+P 输 笔记 → 列出 我的笔记.md', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qzh-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qzh-ws-'));
  try {
    writeFileSync(path.join(ws, '我的笔记.md'), '# x\n');
    writeFileSync(path.join(ws, 'other.txt'), 'x\n');
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
    await expect(input).toBeVisible();
    await expect(win.locator('.wm-modal-content')).toContainText(
      '我的笔记.md',
      { timeout: 10_000 },
    );

    await input.fill('笔记');
    await expect(
      win.locator('.wm-modal-content li').first(),
    ).toContainText('我的笔记.md');
    // other.txt 不匹配
    const text = (
      await win.locator('.wm-modal-content li').allTextContents()
    ).join('\n');
    expect(text).not.toContain('other.txt');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
