import { EXPLORER_TAB, SETTINGS, SETTINGS_NAV } from './helpers/settings';
// showHiddenFiles UI toggle → 重启同 ud → setting 仍 true.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('toggle showHiddenFiles → 重启 → 仍 true + .secret 显', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-shp-'));
  const ws = mkdtempSync(path.join(tmpdir(), 'continuo-shp-ws-'));
  try {
    writeFileSync(path.join(ws, '.secret'), 'x');
    writeFileSync(path.join(ws, 'visible.md'), '# v\n');
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

    // 第一次:toggle setting
    const app1 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win1 = await app1.firstWindow();
    await win1.waitForLoadState('domcontentloaded');

    await win1.getByRole('button', { name: SETTINGS }).click();
    await win1
      .getByRole('navigation', { name: SETTINGS_NAV })
      .getByRole('button', { name: EXPLORER_TAB })
      .click();

    const toggle = win1.locator('button[role=switch]').first();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await win1.waitForTimeout(200);
    await app1.close();

    // 第二次:reload
    const app2 = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win2 = await app2.firstWindow();
    await win2.waitForLoadState('domcontentloaded');

    // .secret 显
    await expect(
      win2.locator('[role=treeitem]').filter({ hasText: /^\.secret$/ }),
    ).toBeVisible({ timeout: 10_000 });

    await app2.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
