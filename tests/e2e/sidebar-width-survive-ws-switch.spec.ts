// 预置 sidebarWidth=400 + 切 ws → sidebar 仍 400px.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorerMoreActionsButton } from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('sidebarWidth=400 hydrate + 切 ws → 仍 400px', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sww-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-sww-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-sww-ws2-'));
  try {
    writeFileSync(path.join(ws1, 'a.md'), '# 1\n');
    writeFileSync(path.join(ws2, 'b.md'), '# 2\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1, ws2] },
        explorer: {
          activePath: null,
          expandedPaths: [ws1],
          sort: { by: 'name', reverse: false },
        },
        pinned: { paths: [] },
        layoutUi: { sidebarOpen: true, sidebarWidth: 400 },
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const sidebar = win.locator('main aside').nth(1);
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
    expect(
      await sidebar.evaluate((el: HTMLElement) => el.style.width),
    ).toBe('400px');

    // 切 ws
    await explorerMoreActionsButton(win).click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();
    await win.waitForTimeout(300);

    expect(
      await sidebar.evaluate((el: HTMLElement) => el.style.width),
    ).toBe('400px');

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
