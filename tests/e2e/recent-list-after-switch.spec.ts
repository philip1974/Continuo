// 切 ws 后,⋯ 菜单的「打开最近」列表展示旧 ws.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorerMoreActionsButton } from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('ws1 → 切 ws2 → ⋯ 「打开最近」 含 ws1', async () => {
  test.setTimeout(30_000);
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rl-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-rl-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-rl-ws2-'));
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

    // 切到 ws2
    await explorerMoreActionsButton(win).click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();

    // 等切换 + recent 重排
    await expect(
      win.locator('main aside').nth(1).getByText(ws2Name).first(),
    ).toBeVisible({ timeout: 10_000 });

    // 再开 ⋯ → 含 ws1
    await explorerMoreActionsButton(win).click();
    const ws1Name = path.basename(ws1);
    await expect(
      win
        .getByRole('menu')
        .getByRole('menuitem', { name: ws1Name, exact: false }),
    ).toBeVisible({ timeout: 5_000 });

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
