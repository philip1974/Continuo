// 中文文件名 trash → 文件被移走.
import { _electron as electron, expect, test } from '@playwright/test';
import { EXPLORER_TRASH } from './helpers/explorer';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('右键 中文文件 → trash → 不在', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-trash-zh-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-trash-zh-ws-'));
  try {
    writeFileSync(path.join(ws, '测试.txt'), 'x');
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

    await win
      .locator('text=测试.txt')
      .first()
      .click({ button: 'right' });
    await win.getByRole('menuitem', { name: EXPLORER_TRASH }).click();

    await expect(async () => {
      let exists = true;
      try {
        statSync(path.join(ws, '测试.txt'));
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }).toPass({ timeout: 5_000 });

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
