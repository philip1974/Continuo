// settings 是全局 localStorage,不随 ws 切重置.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('改 fontSize=18 + 切 ws → fontSize 仍 18', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-sws-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-sws-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-sws-ws2-'));
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

    await win.waitForFunction(
      () =>
        Boolean(
          (window as unknown as { __continuoTest?: unknown }).__continuoTest,
        ),
      { timeout: 5_000 },
    );

    // 改 fontSize=18
    await win.evaluate(() => {
      const t = (
        window as unknown as {
          __continuoTest: { setSettingValue: (id: string, v: number) => void };
        }
      ).__continuoTest;
      t.setSettingValue('editor.fontSize', 18);
    });

    // 切 ws
    await win.locator('button[aria-label=更多操作]').click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();
    await win.waitForTimeout(300);

    // fontSize 仍 18
    const v = await win.evaluate(
      () =>
        (
          window as unknown as {
            __continuoTest: { getSettingValue: (id: string) => unknown };
          }
        ).__continuoTest.getSettingValue('editor.fontSize'),
    );
    expect(v).toBe(18);

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
