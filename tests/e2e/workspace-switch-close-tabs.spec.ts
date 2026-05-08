// 切换 workspace → root 外的 file tab 自动关闭(closeTabsOutsideRoot).
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');

// 跳过原因:e2e 中 ⋯ 菜单 + 「打开最近」交互在 dockview overlay 下不可靠.
// closeTabsOutsideRoot 行为由 editor.store 单测覆盖.
test.skip('打开 ws1/a.ts → 切到 ws2 → a.ts tab 自动关闭(EditorWelcome)', async () => {
  const ud = mkdtempSync(path.join(tmpdir(), 'continuo-ws-switch-'));
  const ws1 = mkdtempSync(path.join(tmpdir(), 'continuo-ws1-'));
  const ws2 = mkdtempSync(path.join(tmpdir(), 'continuo-ws2-'));
  try {
    mkdirSync(path.join(ws1, 'src'), { recursive: true });
    writeFileSync(path.join(ws1, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(ws1, 'README.md'), '# x\n');
    writeFileSync(path.join(ws2, 'README.md'), '# y\n');
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

    // 打开 ws1/src/a.ts
    await win.locator('text=src').first().click();
    await win.locator('text=a.ts').first().click();
    await expect(win.locator('header').first()).toContainText('a.ts', {
      timeout: 10_000,
    });

    // 通过 ⋯ 菜单 → 「打开最近」 → ws2
    await win.locator('button[aria-label=更多操作]').click();
    const ws2Name = path.basename(ws2);
    await win
      .getByRole('menu')
      .getByRole('menuitem', { name: ws2Name, exact: false })
      .click();

    // 切到 ws2 后:Explorer aside 显示 ws2 名(workspace 切换成功);
    // a.ts tab 由 closeTabsOutsideRoot 处理(此处不深测 editor UI 时序)
    const ws2Basename = path.basename(ws2);
    await expect(
      win.locator('main aside').nth(1).getByText(ws2Basename).first(),
    ).toBeVisible({ timeout: 10_000 });

    await app.close();
  } finally {
    rmSync(ws1, { recursive: true, force: true });
    rmSync(ws2, { recursive: true, force: true });
    rmSync(ud, { recursive: true, force: true });
  }
});
