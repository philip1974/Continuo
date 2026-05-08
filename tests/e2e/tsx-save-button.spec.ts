// .tsx file → 视为代码 → Save button.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('Component.tsx → Save button 显', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-tsx-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-tsx-ws-'));
  try {
    writeFileSync(
      path.join(ws, 'Component.tsx'),
      'export const X = () => null;\n',
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

    await win.locator('text=Component.tsx').first().click();
    await expect(win.locator('header').first()).toContainText(
      'Component.tsx',
      { timeout: 10_000 },
    );

    const saveBtn = win
      .locator('main')
      .locator('button')
      .filter({ hasText: /^保存$/ })
      .first();
    await expect(saveBtn).toBeVisible();

    await app.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
