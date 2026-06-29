// recentRoots 持久化:explorer.json 的 recentRoots 数组 hydrate 后,
// ExplorerHeader 的 ⋯ 菜单含「打开最近」段.
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPLORER_OPEN_RECENT,
  explorerMoreActionsButton,
} from './helpers/explorer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

test('recentRoots 中的旧 root → ExplorerHeader ⋯ 「打开最近」列表', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-rr-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-ws2-'));
  try {
    // 当前 root = ws1,recentRoots 含 ws1 + ws2(ws2 是「最近打开过」的另一个)
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'README.md'), '# x\n');
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

    // 等 ExplorerHeader 渲染(workspace 名出现)
    const wsName1 = path.basename(ws1);
    await expect(
      win.locator('main aside').nth(1).getByText(wsName1).first(),
    ).toBeVisible({ timeout: 10_000 });

    // 点 ⋯ 打开菜单
    await explorerMoreActionsButton(win).click();
    await expect(win.getByRole('menu')).toBeVisible();

    // 「打开最近」分组 + ws2 basename
    await expect(win.getByText(EXPLORER_OPEN_RECENT)).toBeVisible();
    const wsName2 = path.basename(ws2);
    await expect(
      win.getByRole('menuitem', { name: wsName2, exact: false }),
    ).toBeVisible();

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
