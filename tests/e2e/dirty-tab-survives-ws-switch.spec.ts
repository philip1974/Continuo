// dirty ws1/a.ts + 切 ws2 → dirty tab 保留,避免静默丢编辑.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITOR_UNSAVED_CHANGES_SELECTOR } from './helpers/editor';
import { explorerMoreActionsButton } from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('dirty ws1/a.ts + 切 ws2 → dirty tab 保留', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-dws-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-dws-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-dws-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(ws2, 'README.md'), '# 2\n');
    writeFileSync(
      path.join(ud, 'explorer.json'),
      JSON.stringify({
        version: 1,
        workspace: { root: ws1, recentRoots: [ws1, ws2] },
        explorer: {
          activePath: null,
          expandedPaths: [ws1, path.join(ws1, 'src')],
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

    const file = win
      .locator('[role=treeitem]')
      .filter({ hasText: /^a\.ts$/ })
      .first();
    await expect(file).toBeVisible({ timeout: 10_000 });
    await file.click();
    const cm = win.locator('.cm-content');
    await expect(cm).toBeVisible({ timeout: 10_000 });
    await cm.click();
    await win.keyboard.type(' // dirty');
    await expect(win.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();

    // 切 ws2
    await explorerMoreActionsButton(win).click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();

    // workspace 已切到 ws2,但 root 外 dirty tab 仍保留,避免静默丢编辑.
    await expect(win.locator('text=README.md')).toBeVisible({
      timeout: 10_000,
    });
    await expect(win.locator(EDITOR_UNSAVED_CHANGES_SELECTOR)).toBeVisible();
    await expect(win.locator('header').first()).toContainText('a.ts');

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
