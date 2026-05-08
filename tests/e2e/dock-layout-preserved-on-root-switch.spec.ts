// 切 workspace root → dock 中已开 panel 不被重置.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('打开 Output → 切 root → Output panel 仍在', async () => {
  test.setTimeout(60_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-dock-rs-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-dock-rs-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-dock-rs-ws2-'));
  try {
    writeFileSync(path.join(ws1, 'README.md'), '# 1\n');
    writeFileSync(path.join(ws2, 'README.md'), '# 2\n');
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
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    // 打开 Output panel
    await win.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown }).__continuoTest,
        ),
      { timeout: 5_000 },
    );
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: {
            openOrFocusPanel: (id: string, c: string, t: string) => void;
          };
        }
      ).__continuoTest;
      t.openOrFocusPanel('output', 'output', 'Output');
    });
    await expect(win.locator('text=Continuo ready')).toBeVisible({
      timeout: 10_000,
    });

    // 切 root
    const wsName2 = path.basename(ws2);
    await win.locator('button[aria-label=更多操作]').click();
    await win.getByRole('menuitem', { name: wsName2, exact: false }).click();

    // Output panel 仍在
    await expect(win.locator('text=Continuo ready')).toBeVisible({
      timeout: 5_000,
    });

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
