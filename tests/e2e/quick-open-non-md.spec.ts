// Quick Open walk 列出所有文件类型(.md / .ts / 无扩展等).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openQuickOpen, quickOpenInput } from './helpers/palette';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('walk 列出 .md / .ts / Makefile(无扩展)三种文件', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-qo-mix-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-qo-mix-ws-'));
  try {
    mkdirSync(path.join(ws, 'src'), { recursive: true });
    writeFileSync(path.join(ws, 'doc.md'), '# x');
    writeFileSync(path.join(ws, 'src/lib.ts'), '');
    writeFileSync(path.join(ws, 'Makefile'), 'all:\n');
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

    await openQuickOpen(win);
    const input = quickOpenInput(win);
    await expect(input).toBeVisible();

    await expect(win.locator('.wm-modal-content')).toContainText('doc.md', {
      timeout: 10_000,
    });
    await expect(win.locator('.wm-modal-content')).toContainText('lib.ts');
    await expect(win.locator('.wm-modal-content')).toContainText('Makefile');

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
