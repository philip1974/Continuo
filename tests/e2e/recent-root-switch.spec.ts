// ⋯ → 「打开最近」 → 点 ws2 → root 切到 ws2 + Explorer 显 ws2 名.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorerMoreActionsButton } from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('点 ⋯ → 打开最近 → ws2 → root 切到 ws2', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rr-switch-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'README.md'), '# ws1\n');
    writeFileSync(path.join(ws2, 'CHANGELOG.md'), '# ws2\n');
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

    const wsName1 = path.basename(ws1);
    const wsName2 = path.basename(ws2);
    await expect(
      win.locator('main aside').nth(1).getByText(wsName1).first(),
    ).toBeVisible({ timeout: 10_000 });

    await explorerMoreActionsButton(win).click();
    await expect(win.getByRole('menu')).toBeVisible();
    await win
      .getByRole('menuitem', { name: wsName2, exact: false })
      .click();

    // 切到 ws2 → 显 ws2 文件
    await expect(
      win.locator('main aside').nth(1).getByText(wsName2).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(win.locator('text=CHANGELOG.md')).toBeVisible();

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
