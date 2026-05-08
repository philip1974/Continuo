// theme=light + 切 ws → html 仍不含 dark.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('theme=light + 切 ws → 仍 light', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-tws-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-tws-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-tws-ws2-'));
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
      }),
    );

    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${ud}`],
      env: { ...process.env, ELECTRON_DISABLE_GPU: '1', CONTINUO_E2E: '1' },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

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
          __continuoTest: { setSettingValue: (id: string, v: string) => void };
        }
      ).__continuoTest;
      t.setSettingValue('general.theme', 'light');
    });
    await expect(win.locator('html')).not.toHaveClass(/dark/, {
      timeout: 5_000,
    });

    // 切 ws
    await win.locator('button[aria-label=更多操作]').click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();
    await win.waitForTimeout(300);

    await expect(win.locator('html')).not.toHaveClass(/dark/);

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
